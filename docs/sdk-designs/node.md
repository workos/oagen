# Node/TypeScript SDK Design

This document defines the patterns and conventions for the Node/TypeScript language emitter (`src/emitters/node/`). It also serves as the structural template for the generated SDK.

> **Upstream reference**: `/Users/gjtorikian/workos/sdks/backend/workos-node/`

## Architecture Overview

```
{Namespace}
├── .organizations      → Organizations (resource class)
├── .users              → Users (resource class)
└── .{resource}         → {Resource} (resource class)

Organization            → Public interface (camelCase)
OrganizationResponse    → Response interface (snake_case)
deserializeOrganization → Response → Public converter

{Namespace} (class)
├── constructor(keyOrOptions)  → String API key or options object
├── get/post/put/patch/delete  → HTTP methods with retry
└── handleHttpError            → Status code → exception dispatch
```

## Naming Conventions

| IR Name               | TypeScript Name      | File Name                   | Method Name |
| --------------------- | -------------------- | --------------------------- | ----------- |
| `UserProfile`         | `UserProfile`        | `user-profile.interface.ts` | —           |
| `listUsers`           | —                    | —                           | `listUsers` |
| `user_id` (field)     | `userId` (public)    | —                           | —           |
| `user_id` (response)  | `user_id` (response) | —                           | —           |
| `ACTIVE` (enum value) | `'active'`           | —                           | —           |

## Type Mapping

| IR TypeRef          | TypeScript (Public) | TypeScript (Response)    |
| ------------------- | ------------------- | ------------------------ |
| `primitive:string`  | `string`            | `string`                 |
| `primitive:integer` | `number`            | `number`                 |
| `primitive:number`  | `number`            | `number`                 |
| `primitive:boolean` | `boolean`           | `boolean`                |
| `array<T>`          | `T[]`               | `TResponse[]`            |
| `model:Foo`         | `Foo`               | `FooResponse`            |
| `enum:Foo`          | `Foo`               | `Foo`                    |
| `nullable<T>`       | `T \| null`         | `T \| null`              |
| `union<A,B>`        | `A \| B`            | `AResponse \| BResponse` |

## Model Pattern

Models use dual interfaces (public camelCase + response snake_case) plus serializer functions.

```typescript
// src/{service}/interfaces/{model}.interface.ts
export interface Organization {
  /** The unique identifier */
  id: string;
  createdAt: string;
  externalId?: string | null;
}

export interface OrganizationResponse {
  id: string;
  created_at: string;
  external_id?: string | null;
}

// src/{service}/serializers/{model}.serializer.ts
export const deserializeOrganization = (
  response: OrganizationResponse,
): Organization => ({
  id: response.id,
  createdAt: response.created_at,
  externalId: response.external_id ?? null,
});
```

### Serializer Rules

- Primitive fields: direct rename `snake_case` → `camelCase`
- Model ref fields: call nested `deserialize{Model}(response.{field})`
- Array of models: `.map(deserialize{Model})`
- Nullable: `?? null`
- Optional: spread pattern `...(typeof response.{field} === 'undefined' ? undefined : { {camelField}: response.{field} })`

## Enum Pattern

Enums use string literal union types (not TypeScript `enum`):

```typescript
export type OrganizationStatus = "active" | "inactive";
```

Output path: `src/common/interfaces/{enum-name}.interface.ts`

## Resource Pattern

Resources are classes accepting the client instance, with async methods for each operation:

```typescript
export class Organizations {
  constructor(private readonly workos: WorkOS) {}

  async listOrganizations(options?: ListOrganizationsOptions): Promise<AutoPaginatable<Organization>> { ... }
  async createOrganization(payload: CreateOrganizationOptions, requestOptions?: CreateOrganizationRequestOptions): Promise<Organization> { ... }
  async getOrganization(id: string): Promise<Organization> { ... }
  async deleteOrganization(id: string): Promise<void> { ... }
}
```

### Operation Mapping

| Pattern           | Implementation                                     |
| ----------------- | -------------------------------------------------- |
| Paginated GET     | `AutoPaginatable` + `fetchAndDeserialize`          |
| Non-paginated GET | `this.{ns}.get<Response>` + deserialize            |
| POST (idempotent) | `this.{ns}.post` + serialize body + requestOptions |
| PUT/PATCH         | `this.{ns}.put`/`patch` + serialize + deserialize  |
| DELETE            | `this.{ns}.delete`, returns `Promise<void>`        |
| Path params       | Template literals: `` `/organizations/${id}` ``    |

## Client Pattern

```typescript
export class WorkOS {
  constructor(keyOrOptions?: string | WorkOSOptions);

  async get<Result>(path, options?: GetOptions): Promise<{ data: Result }>;
  async post<Result, Entity>(
    path,
    entity,
    options?: PostOptions,
  ): Promise<{ data: Result }>;
  async put<Result, Entity>(
    path,
    entity,
    options?: PutOptions,
  ): Promise<{ data: Result }>;
  async patch<Result, Entity>(
    path,
    entity,
    options?: PatchOptions,
  ): Promise<{ data: Result }>;
  async delete(path, query?): Promise<void>;
}
```

Key behaviors:

- API key from constructor param or `{NAMESPACE}_API_KEY` env var
- Resource accessors as readonly properties
- Retry with exponential backoff + jitter (retryable statuses: 429, 500, 502, 503, 504)
- Auto-generated Idempotency-Key for POST requests
- Max retry attempts: 3, backoff multiplier: 1.5

## Error Hierarchy

| Class                           | Status |
| ------------------------------- | ------ |
| `GenericServerException` (base) | any    |
| `UnauthorizedException`         | 401    |
| `BadRequestException`           | 400    |
| `NotFoundException`             | 404    |
| `ConflictException`             | 409    |
| `UnprocessableEntityException`  | 422    |
| `RateLimitExceededException`    | 429    |
| `ApiKeyRequiredException`       | —      |

All exceptions extend `Error` and implement `RequestException` (except `ApiKeyRequiredException`).

## Test Pattern

- Framework: Jest + jest-fetch-mock
- Test file path: `src/{service}/{service}.spec.ts` (colocated)
- Uses `fetchOnce`, `fetchURL`, `fetchHeaders`, `fetchBody` test utilities
- `beforeEach(() => fetch.resetMocks())`

### Test Categories

1. **CRUD tests**: One per operation, mocks fetch, asserts response defined
2. **Error tests**: 404 NotFoundException, 401 UnauthorizedException
3. **Retry tests**: 429 with Retry-After header, verifies request count
4. **Idempotency tests**: Explicit key via header, auto-generated UUID key

## Generated SDK Directory Structure

```
src/
├── {resource}/
│   ├── {resource}.ts                    # Resource class
│   ├── {resource}.spec.ts               # Tests (colocated)
│   ├── interfaces/
│   │   ├── {entity}.interface.ts        # Public + Response interfaces
│   │   └── index.ts                     # Barrel export
│   ├── serializers/
│   │   ├── {entity}.serializer.ts       # Deserialize functions
│   │   └── index.ts                     # Barrel export
│   └── fixtures/
│       └── {operation}.json             # Test fixtures
├── common/
│   ├── exceptions/                      # Error classes + index.ts
│   ├── interfaces/                      # Shared types
│   ├── net/                             # HttpClient abstract + FetchHttpClient
│   └── utils/                           # Pagination, fetch-and-deserialize, test-utils
├── {namespace}.ts                       # Main client class
├── factory.ts                           # Factory function
└── index.ts                             # Barrel exports
```

## Structural Guidelines

| Category          | Choice            | Notes                                  |
| ----------------- | ----------------- | -------------------------------------- |
| Testing Framework | Jest              | + jest-fetch-mock for HTTP mocking     |
| Documentation     | TSDoc             | `/** @param */` style                  |
| Types             | Inline            | No separate .d.ts files                |
| HTTP Client       | native `fetch`    | Via FetchHttpClient adapter            |
| Build             | tsdown            | ESM + CJS dual output                  |
| Linting           | ESLint + Prettier | Standard config                        |
| Package Manager   | npm               | package.json with scripts              |
| Interfaces        | Dual              | Public camelCase + response snake_case |

## File Header

```typescript
// This file is auto-generated by oagen. Do not edit manually.
```
