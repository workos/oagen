import type { ApiSpec, Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { rubyClassName, rubyFileName } from './naming.js';
import { generateFixtures } from './fixtures.js';

export function generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of spec.services) {
    files.push({
      path: `test/${ctx.namespace}/resources/${rubyFileName(service.name)}_test.rb`,
      content: generateTestFile(service, ctx),
    });
  }

  files.push(...generateFixtures(spec, ctx));

  return files;
}

function generateTestFile(service: Service, ctx: EmitterContext): string {
  const className = rubyClassName(service.name);
  const lines: string[] = [];

  lines.push(`require_relative "../../test_helper"`);
  lines.push('');
  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Resources');
  lines.push(`    class ${className}Test < Minitest::Test`);
  lines.push('      def setup');
  lines.push(`        @client = ${ctx.namespacePascal}::Client.new(api_key: "sk_test_xxx")`);
  lines.push('      end');

  // CRUD tests
  lines.push('');
  lines.push('      # === CRUD Tests ===');

  for (const op of service.operations) {
    lines.push('');
    lines.push(...generateCrudTest(op, service, ctx));
  }

  // Error tests
  const retrieveOp = service.operations.find((o) => o.name === 'retrieve');
  const listOp = service.operations.find((o) => o.name === 'list');
  if (retrieveOp || listOp) {
    lines.push('');
    lines.push('      # === Error Tests ===');
    lines.push('');
    lines.push(...generateErrorTests(retrieveOp || listOp!, service, ctx));
  }

  // Retry tests
  if (listOp) {
    lines.push('');
    lines.push('      # === Retry Tests ===');
    lines.push('');
    lines.push(...generateRetryTests(listOp, service, ctx));
  }

  // Idempotency tests
  const createOp = service.operations.find((o) => o.name === 'create' && o.idempotent);
  if (createOp) {
    lines.push('');
    lines.push('      # === Idempotency Tests ===');
    lines.push('');
    lines.push(...generateIdempotencyTests(createOp, service, ctx));
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateCrudTest(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const httpMethod = op.httpMethod;
  const baseUrl = `https://api.example.com`;
  const url = `${baseUrl}/${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'test_id')}`;
  const resourceMethod = rubyFileName(service.name);

  lines.push(`      def test_${op.name}`);
  lines.push(`        stub_request(:${httpMethod}, "${url}")`);

  const statusCode = op.httpMethod === 'delete' ? 204 : op.httpMethod === 'post' ? 201 : 200;

  if (statusCode === 204) {
    lines.push(`          .to_return(status: ${statusCode}, body: "")`);
  } else {
    const fixtureName = getResponseFixtureName(op, service);
    lines.push(`          .to_return(status: ${statusCode}, body: load_fixture("${fixtureName}.json"))`);
  }

  // Build method call
  const args: string[] = [];
  for (const _p of op.pathParams) {
    args.push('"test_id"');
  }
  if (op.requestBody) {
    args.push('{ name: "test" }');
  }
  if (op.queryParams.length > 0 && !op.requestBody) {
    // list methods with default params don't need args
  }

  const call =
    args.length > 0
      ? `@client.${resourceMethod}.${op.name}(${args.join(', ')})`
      : `@client.${resourceMethod}.${op.name}`;

  lines.push(`        response = ${call}`);
  lines.push('');

  if (op.paginated) {
    lines.push(`        assert_pattern { response => ${ctx.namespacePascal}::Internal::CursorPage }`);
  } else if (statusCode === 204) {
    lines.push('        assert_nil response');
  } else {
    const modelName = getResponseModelName(op);
    if (modelName !== 'Object') {
      lines.push(`        assert_pattern { response => ${ctx.namespacePascal}::Models::${modelName} }`);
    } else {
      lines.push('        refute_nil response');
    }
  }

  lines.push('      end');

  return lines;
}

function generateErrorTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const httpMethod = op.httpMethod;
  const baseUrl = `https://api.example.com`;
  const url = `${baseUrl}/${stripLeadingSlash(op.path).replace(/\{[^}]+\}/g, 'invalid')}`;
  const resourceMethod = rubyFileName(service.name);

  const callArgs = op.pathParams.length > 0 ? '("invalid")' : '';

  // 404 test
  lines.push('      def test_not_found');
  lines.push(`        stub_request(:${httpMethod}, "${url}")`);
  lines.push('          .to_return(status: 404, body: { message: "Not found" }.to_json)');
  lines.push('');
  lines.push(`        assert_raises(${ctx.namespacePascal}::NotFoundError) do`);
  lines.push(`          @client.${resourceMethod}.${op.name}${callArgs}`);
  lines.push('        end');
  lines.push('      end');
  lines.push('');

  // 401 test
  const authOp = service.operations.find((o) => o.name === 'list') || op;
  const authUrl = `${baseUrl}/${stripLeadingSlash(authOp.path).replace(/\{[^}]+\}/g, 'test_id')}`;

  lines.push('      def test_authentication_error');
  lines.push(`        stub_request(:${authOp.httpMethod}, "${authUrl}")`);
  lines.push('          .to_return(status: 401, body: { message: "Unauthorized" }.to_json)');
  lines.push('');
  lines.push(`        assert_raises(${ctx.namespacePascal}::AuthenticationError) do`);
  const authCallArgs = authOp.pathParams.length > 0 ? '("test_id")' : '';
  lines.push(`          @client.${resourceMethod}.${authOp.name}${authCallArgs}`);
  lines.push('        end');
  lines.push('      end');

  return lines;
}

function generateRetryTests(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const baseUrl = `https://api.example.com`;
  const url = `${baseUrl}/${stripLeadingSlash(op.path)}`;
  const resourceMethod = rubyFileName(service.name);
  const fixtureName = getResponseFixtureName(op, service);

  lines.push('      def test_retry_on_rate_limit');
  lines.push(`        stub_request(:${op.httpMethod}, "${url}")`);
  lines.push('          .to_return({ status: 429, headers: { "Retry-After" => "1" } })');
  lines.push(`          .then.to_return({ status: 200, body: load_fixture("${fixtureName}.json") })`);
  lines.push('');
  lines.push(`        client = ${ctx.namespacePascal}::Client.new(api_key: "sk_test_xxx", max_retries: 2)`);
  lines.push(`        response = client.${resourceMethod}.${op.name}`);
  lines.push('');
  lines.push(`        assert_requested :${op.httpMethod}, "${url}", times: 2`);
  lines.push('      end');

  return lines;
}

function generateIdempotencyTests(op: Operation, service: Service, _ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const baseUrl = `https://api.example.com`;
  const url = `${baseUrl}/${stripLeadingSlash(op.path)}`;
  const resourceMethod = rubyFileName(service.name);
  const fixtureName = getResponseFixtureName(op, service);

  // Explicit idempotency key test
  lines.push('      def test_idempotency_key_sent');
  lines.push(`        stub_request(:post, "${url}")`);
  lines.push('          .with(headers: { "Idempotency-Key" => "my_key" })');
  lines.push(`          .to_return(status: 201, body: load_fixture("${fixtureName}.json"))`);
  lines.push('');
  lines.push(`        @client.${resourceMethod}.create({ name: "Test" }, idempotency_key: "my_key")`);
  lines.push('');
  lines.push(`        assert_requested :post, "${url}",`);
  lines.push('          headers: { "Idempotency-Key" => "my_key" }');
  lines.push('      end');
  lines.push('');

  // Auto-generated idempotency key test
  lines.push('      def test_idempotency_key_auto_generated');
  lines.push('        captured_key = nil');
  lines.push(`        stub_request(:post, "${url}")`);
  lines.push('          .with { |req| captured_key = req.headers["Idempotency-Key"]; true }');
  lines.push(`          .to_return(status: 201, body: load_fixture("${fixtureName}.json"))`);
  lines.push('');
  lines.push(`        @client.${resourceMethod}.create(name: "Test")`);
  lines.push('');
  lines.push('        refute_nil captured_key');
  lines.push('        assert_match(/\\A[0-9a-f-]{36}\\z/i, captured_key)');
  lines.push('      end');

  return lines;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function getResponseFixtureName(op: Operation, service: Service): string {
  const resourceName = rubyFileName(service.name);
  return `${resourceName}/${op.name}`;
}

function getResponseModelName(op: Operation): string {
  if (op.response.kind === 'model') {
    return op.response.name;
  }
  if (op.response.kind === 'array' && op.response.items.kind === 'model') {
    return op.response.items.name;
  }
  return 'Object';
}
