# Ruby SDK Design

This document defines the patterns and conventions for the Ruby language emitter (`src/emitters/ruby/`). It also serves as the structural template for new language design docs — see Step 0d of `.claude/skills/generate-emitter/SKILL.md` for the required sections.

> **Upstream reference**: `/Users/gjtorikian/workos/sdks/backend/workos-ruby/.claude/SDK_DESIGN.md`

## Architecture Overview

```
{Namespace}::Client
├── .organizations      → {Namespace}::Resources::Organizations
├── .users              → {Namespace}::Resources::Users
└── .{resource}         → {Namespace}::Resources::{Resource}

{Namespace}::Models
├── Organization        → BaseModel subclass (response model)
├── OrganizationCreateParams → BaseModel subclass (input params)
└── {Resource}          → BaseModel subclass

{Namespace} (module)
├── .configure { }      → Block-style configuration
└── .configuration      → Lazy-loaded Configuration instance
```

## Naming Conventions

| IR Name | Ruby Class | Ruby File | Ruby Method |
|---------|-----------|-----------|-------------|
| `UserProfile` | `UserProfile` | `user_profile.rb` | — |
| `listUsers` | — | — | `list_users` |
| `user_id` (field) | — | — | `:user_id` |
| `ACTIVE` (enum value) | `ACTIVE = :active` | — | — |

## Type Mapping

| IR TypeRef | Ruby BaseModel Type | RBS Type | Sorbet Type | YARD Type |
|------------|-------------------|----------|-------------|-----------|
| `primitive:string` | `String` | `String` | `String` | `String` |
| `primitive:string:date` | `Date` | `Date` | `Date` | `Date` |
| `primitive:string:date-time` | `Time` | `Time` | `Time` | `Time` |
| `primitive:integer` | `Integer` | `Integer` | `Integer` | `Integer` |
| `primitive:number` | `Float` | `Float` | `Float` | `Float` |
| `primitive:boolean` | `{NS}::Internal::Type::Boolean` | `bool` | `T::Boolean` | `Boolean` |
| `array` | `{NS}::Internal::Type::ArrayOf[T]` | `Array[T]` | `T::Array[T]` | `Array<T>` |
| `model:Foo` | `-> { {NS}::Models::Foo }` | `{NS}::Models::Foo` | `{NS}::Models::Foo` | `{NS}::Models::Foo` |
| `enum:Foo` | `enum: -> { {NS}::Models::Foo }` | `Symbol` | `Symbol` | `Symbol` |
| `nullable` | `T, nil?: true` | `T?` | `T.nilable(T)` | `T, nil` |
| `union` | `{NS}::Internal::Type::Union[...]` | `T1 \| T2` | `T.any(T1, T2)` | `T1, T2` |

## Model Pattern

Models include YARD `@!attribute` documentation for every field.

```ruby
# frozen_string_literal: true

module {Namespace}
  module Models
    # A user record
    class Organization < {Namespace}::Internal::Type::BaseModel
      # @!attribute id
      #   @return [String]
      required :id, String

      # @!attribute name
      #   The organization name
      #   @return [String]
      required :name, String

      # @!attribute external_id
      #   @return [String]
      optional :external_id, String

      # @!attribute deleted_at
      #   @return [Time, nil]
      optional :deleted_at, Time, nil?: true

      # @!attribute state
      #   @return [Symbol]
      required :state, enum: -> { {Namespace}::Models::OrganizationStatus }
    end
  end
end
```

## Enum Pattern

Enums use module-based pattern with `extend Enum` and symbol values (not class inheritance, not string values).

```ruby
module {Namespace}
  module Models
    module OrganizationStatus
      extend {Namespace}::Internal::Type::Enum

      ACTIVE = :active
      INACTIVE = :inactive
    end
  end
end
```

## Resource Pattern

Resources use keyword-style `@client.request(method:, path:, ...)` with explicit `model:` and `page:` parameters. Every method includes `request_options:` as the last keyword argument. Idempotent POST methods have a standalone `idempotency_key:` parameter. Paths strip the leading `/`.

```ruby
module {Namespace}
  module Resources
    class Organizations
      # @param client [{Namespace}::Client]
      def initialize(client:)
        @client = client
      end

      # List all organizations
      #
      # @param params [Hash] Query parameters
      # @param request_options [Hash, nil] Override request options
      # @return [{Namespace}::Internal::CursorPage[{Namespace}::Models::Organization]]
      def list(params = {}, request_options: nil)
        @client.request(
          method: :get,
          path: "organizations",
          query: params,
          page: {Namespace}::Internal::CursorPage,
          model: {Namespace}::Models::Organization,
          options: request_options
        )
      end

      # Retrieve an organization by ID
      #
      # @param id [String] The id
      # @param request_options [Hash, nil] Override request options
      # @return [{Namespace}::Models::Organization]
      def retrieve(id, request_options: nil)
        @client.request(
          method: :get,
          path: ["organizations/%1$s", id],
          model: {Namespace}::Models::Organization,
          options: request_options
        )
      end

      # Create an organization
      #
      # @param params [Hash] Request body
      # @param idempotency_key [String, nil] Unique key for idempotent requests
      # @param request_options [Hash, nil] Override request options
      # @return [{Namespace}::Models::Organization]
      def create(params, idempotency_key: nil, request_options: nil)
        @client.request(
          method: :post,
          path: "organizations",
          body: params,
          model: {Namespace}::Models::Organization,
          idempotency_key: idempotency_key,
          options: request_options
        )
      end

      # Delete an organization
      #
      # @param id [String] The id
      # @param request_options [Hash, nil] Override request options
      # @return [nil]
      def delete(id, request_options: nil)
        @client.request(
          method: :delete,
          path: ["organizations/%1$s", id],
          model: NilClass,
          options: request_options
        )
      end
    end
  end
end
```

## Client Pattern

The client uses keyword arguments for `request`:

```ruby
def request(method:, path:, query: nil, body: nil, model: nil, page: nil, idempotency_key: nil, options: nil)
```

Key behaviors:
- `model:` and `page:` parameters control response deserialization
- `model: NilClass` for delete operations (returns nil)
- `page.new(model: model, page: parsed)` for paginated responses
- `model.new(parsed)` for single-model responses
- `options:` supports `:timeout` and `:extra_headers` overrides
- Resource accessors include YARD `@return` docs

## Error Hierarchy

```ruby
{Namespace}::APIError < StandardError         # base
{Namespace}::AuthenticationError < APIError    # 401
{Namespace}::NotFoundError < APIError          # 404
{Namespace}::UnprocessableEntityError < APIError # 422
{Namespace}::RateLimitExceededError < APIError # 429
{Namespace}::ServerError < APIError            # 500+
{Namespace}::NetworkError < APIError           # connection failures
{Namespace}::ConfigurationError < StandardError # missing API key
```

## Test Pattern

- Framework: Minitest
- HTTP mocking: WebMock
- Test file path: `test/{namespace}/resources/{name}_test.rb`
- Test classes nested in modules: `module {NS}; module Resources; class {Name}Test < Minitest::Test`
- Uses `require_relative "../../test_helper"`
- Uses `load_fixture("{resource}/{operation}.json")` helper
- Fixture path pattern: `test/fixtures/{resource}/{operation}.json`
- Assertions use `assert_pattern { response => {NS}::Models::Model }` (not `assert_instance_of`)

### Test Categories

1. **CRUD tests**: One per operation, stubs WebMock, asserts response type
2. **Error tests**: 404 NotFoundError, 401 AuthenticationError
3. **Retry tests**: 429 with Retry-After header, verifies request count
4. **Idempotency tests**: Explicit key sent via header, auto-generated UUID key

## RBS/RBI Type Signatures

### RBS
- Model field attributes include optionality (`?` suffix for optional fields)
- Enum modules with `Symbol` constant types
- Resource methods include `request_options`, `idempotency_key` parameters
- Delete operations return `void`

### RBI (Sorbet)
- `# typed: strong` header
- Enum modules with `T.let(:value, Symbol)` constants
- Resource methods include `request_options: T.nilable(T::Hash[Symbol, T.untyped])`
- Delete operations return `NilClass`

## Generated SDK Directory Structure

```
lib/{namespace}/
├── models/           # One .rb per model/enum
├── resources/        # One .rb per service
├── client.rb         # HTTP client with retry (keyword args)
├── errors.rb         # Error hierarchy
└── configuration.rb  # Config module
sig/{namespace}/
├── models/           # .rbs type signatures (models + enums)
└── resources/        # .rbs type signatures
rbi/{namespace}/
├── models/           # .rbi Sorbet signatures (models + enums)
└── resources/        # .rbi Sorbet signatures
test/
├── {namespace}/resources/
│   └── {name}_test.rb  # One test file per resource
└── fixtures/
    └── {resource}/     # Fixture JSON per operation
```

## Structural Guidelines

| Category | Choice | Notes |
|----------|--------|-------|
| Testing Framework | Minitest | Stdlib-based, lightweight. RSpec also acceptable |
| HTTP Mocking | WebMock | Stubs Net::HTTP (and other clients) at the adapter level |
| Documentation | YARD | @param, @return, @raise tags. Generates HTML docs |
| Type Signatures | Sorbet (RBI) + RBS | Sorbet for static analysis, RBS for stdlib-compatible sigs |
| Linting/Formatting | Standard (StandardRB) | Zero-config Rubocop wrapper. Enforces consistent style |
| HTTP Client (default) | Net::HTTP (stdlib) | No external deps needed |
| JSON Parsing | json (stdlib) | No external deps needed |
| Package Manager | Bundler / RubyGems | gemspec for metadata, Gemfile for dev deps |
| CI/CD | GitHub Actions | Matrix testing across Ruby versions |

## File Header

```ruby
# frozen_string_literal: true
# This file is auto-generated by oagen. Do not edit manually.
```
