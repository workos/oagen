import { describe, expect, it } from 'vitest';
import { runSnippetEmitters, snippetResultsToFiles } from '../../src/snippets/runner.js';
import type { SnippetEmitter } from '../../src/snippets/types.js';
import type { EmitterContext } from '../../src/engine/types.js';
import type { ApiSpec, Operation, Service } from '../../src/ir/types.js';
import type { ResolvedOperation } from '../../src/ir/operation-hints.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function makeOp(name: string, path: string): Operation {
  return {
    name,
    httpMethod: 'get',
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'void' } as never,
    errors: [],
    injectIdempotencyKey: false,
  };
}

function makeCtx(): EmitterContext {
  const service: Service = { name: 'Organizations', operations: [makeOp('list', '/orgs')] };
  const spec: ApiSpec = {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [service],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  const resolved: ResolvedOperation[] = [
    {
      operation: service.operations[0]!,
      service,
      methodName: 'list_organizations',
      mountOn: 'Organizations',
      defaults: {},
      inferFromClient: [],
      urlBuilder: false,
    },
  ];
  return {
    namespace: 'workos',
    namespacePascal: 'WorkOS',
    spec,
    resolvedOperations: resolved,
  };
}

const echoEmitter: SnippetEmitter = {
  language: 'echo',
  fileExtension: 'txt',
  renderOperation: (op) => `${op.mountOn}.${op.methodName}`,
};

const skipEmitter: SnippetEmitter = {
  language: 'skip',
  fileExtension: 'txt',
  renderOperation: () => null,
};

describe('snippets/runner', () => {
  it('returns an empty list when no resolved operations are present', () => {
    const ctx: EmitterContext = { ...makeCtx(), resolvedOperations: [] };
    expect(runSnippetEmitters([echoEmitter], ctx)).toEqual([]);
  });

  it('returns an empty list when resolvedOperations is undefined', () => {
    const ctx: EmitterContext = { ...makeCtx(), resolvedOperations: undefined };
    expect(runSnippetEmitters([echoEmitter], ctx)).toEqual([]);
  });

  it('invokes each emitter once per resolved operation', () => {
    const results = runSnippetEmitters([echoEmitter, echoEmitter], makeCtx());
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toBe('Organizations.list_organizations\n');
  });

  it('omits operations where an emitter returns null', () => {
    const results = runSnippetEmitters([echoEmitter, skipEmitter], makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0]!.language).toBe('echo');
  });

  it('appends a trailing newline when the emitter omits one', () => {
    const results = runSnippetEmitters([echoEmitter], makeCtx());
    expect(results[0]!.content.endsWith('\n')).toBe(true);
  });

  it('exposes operationId, mountTarget, methodName on results', () => {
    const [r] = runSnippetEmitters([echoEmitter], makeCtx());
    expect(r).toMatchObject({
      operationId: 'Organizations.list_organizations',
      mountTarget: 'Organizations',
      methodName: 'list_organizations',
      language: 'echo',
      fileExtension: 'txt',
    });
  });
});

describe('snippets/runner: snippetResultsToFiles', () => {
  it('maps results into <outputDir>/<language>/<methodName>-request.<ext> files', () => {
    const results = runSnippetEmitters([echoEmitter], makeCtx());
    const files = snippetResultsToFiles(results, 'samples');
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('samples/echo/list_organizations-request.txt');
    expect(files[0]!.overwriteExisting).toBe(true);
    expect(files[0]!.integrateTarget).toBe(false);
  });

  it('defaults outputDir to "snippets"', () => {
    const results = runSnippetEmitters([echoEmitter], makeCtx());
    const [file] = snippetResultsToFiles(results);
    expect(file!.path).toBe('snippets/echo/list_organizations-request.txt');
  });
});
