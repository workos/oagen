import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import type { Operation, ResponseContent, TypeRef } from '../../src/ir/types.js';

const string: TypeRef = { kind: 'primitive', type: 'string' };
const binary: TypeRef = { kind: 'primitive', type: 'string', format: 'binary' };
const problem: TypeRef = { kind: 'model', name: 'Problem' };
const report: TypeRef = { kind: 'model', name: 'Report' };
const thing: TypeRef = { kind: 'model', name: 'Thing' };

const contents = (entries: Array<[string, TypeRef]>): ResponseContent[] =>
  entries.map(([contentType, type]) => ({ contentType, type }));

/** The issue's card operation as the parser builds it: `response` is the PDF, whose entry shares the object. */
const card = (entries: Array<[string, TypeRef]>, over: Partial<Operation> = {}): Operation => ({
  name: 'renderPetCard',
  httpMethod: 'get',
  path: '/pets/{petId}/card',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: binary,
  responseContentTypes: entries.map(([contentType]) => contentType),
  responseContents: contents(entries),
  errors: [],
  injectIdempotencyKey: false,
  ...over,
});

/** The operations the parser extracts from an inline paths object. */
const parsed = (paths: Record<string, unknown>): Operation[] =>
  extractOperations(paths as never).services.flatMap((s) => s.operations);

/**
 * The issue's document: the card renders as HTML (`{ type: 'string' }`) or as
 * a PDF, and a missing pet is an object under a problem+json media type. Only
 * the two keys vary between the old and the new document.
 */
const document = (html: string, problemJson: string) => ({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/pets/{petId}/card': {
      get: {
        operationId: 'renderPetCard',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The card',
            content: {
              [html]: { schema: { type: 'string' } },
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '404': {
            description: 'No such pet',
            content: { [problemJson]: { schema: { type: 'object', properties: { detail: { type: 'string' } } } } },
          },
        },
      },
    },
  },
});

describe('diffSpecs — response media types are compared by essence (issue #279)', () => {
  it("reports no change when a response's media types only change case or gain a charset", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oagen-279-'));
    try {
      const oldPath = join(dir, 'old.json');
      const newPath = join(dir, 'new.json');
      writeFileSync(oldPath, JSON.stringify(document('text/html', 'application/problem+json')));
      writeFileSync(newPath, JSON.stringify(document('Text/HTML', 'application/problem+json; charset=utf-8')));
      const { changes, summary } = diffSpecs(await parseSpec(oldPath), await parseSpec(newPath));
      expect(changes).toEqual([]);
      expect(summary.breaking).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every key as written in the IR; only the comparison folds them', () => {
    const [before] = parsed(document('text/html', 'application/problem+json').paths);
    const [after] = parsed(document('Text/HTML', 'application/problem+json; charset=utf-8').paths);
    expect(before.responseContentTypes).toEqual(['text/html', 'application/pdf']);
    expect(after.responseContentTypes).toEqual(['Text/HTML', 'application/pdf']);
    expect(before.errors[0].contentTypes).toEqual(['application/problem+json']);
    expect(after.errors[0].contentTypes).toEqual(['application/problem+json; charset=utf-8']);
    expect(diffOperations('Pets', [before], [after])).toEqual([]);
    expect(diffOperations('Pets', [after], [before])).toEqual([]);
  });

  it('pairs the implicit application/json entry of a listless error with a charset spelling the IR keeps lists for', () => {
    const missing = (json: string) => ({
      '/pets/{petId}/card': {
        get: {
          operationId: 'renderPetCard',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            '404': { description: 'missing', content: { [json]: { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    });
    const plain = parsed(missing('application/json'));
    const charset = parsed(missing('application/json; charset=utf-8'));
    // A lone application/json error with a schema carries no lists in the IR; any other spelling does.
    expect(plain[0].errors[0].contentTypes).toBeUndefined();
    expect(charset[0].errors[0].contentTypes).toEqual(['application/json; charset=utf-8']);
    expect(diffOperations('Pets', plain, charset)).toEqual([]);
    expect(diffOperations('Pets', charset, plain)).toEqual([]);
  });
});

describe('diffOperations — response media types are compared by essence (issue #279)', () => {
  it('ignores whitespace around the essence and every parameter, as the parser does when it types the body', () => {
    // `charset` does not change what a text body is, and `application/pdf;
    // version=2.0` is typed exactly as `application/pdf`: the essence is the
    // whole comparison, so no parameter is reported on its own.
    const old = card([
      ['text/html', string],
      ['application/pdf', binary],
    ]);
    const next = card([
      [' text/html ; charset=utf-8', string],
      ['application/pdf; version=2.0', binary],
    ]);
    expect(diffOperations('Pets', [old], [next])).toEqual([]);
    expect(diffOperations('Pets', [next], [old])).toEqual([]);
  });

  it('still reports a media type whose essence changed, suffix and subtype included', () => {
    const old = card([
      ['text/html', string],
      ['application/pdf', binary],
    ]);
    const next = card([
      ['text/plain', string],
      ['application/pdf', binary],
    ]);
    expect(diffOperations('Pets', [old], [next])[0]).toMatchObject({
      responseContentTypeChanges: [
        { added: ['text/plain'], removed: ['text/html'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
    const json = card([['application/json', report]], { name: 'getReport', response: report });
    const problemJson = card([['application/problem+json', report]], { name: 'getReport', response: report });
    expect(diffOperations('Reports', [json], [problemJson])[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { added: ['application/problem+json'], removed: ['application/json'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it('reports a body retyped under a respelled key once, as retyped under the new spelling', () => {
    const old = card([
      ['text/html', string],
      ['application/pdf', binary],
    ]);
    const next = card([
      ['Text/HTML', { kind: 'model', name: 'CardPage' }],
      ['application/pdf', binary],
    ]);
    expect(diffOperations('Pets', [old], [next])[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [{ added: [], removed: [], retyped: ['Text/HTML'], classification: 'breaking' }],
      classification: 'breaking',
    });
  });

  it("leaves a respelled own body's retype to responseChanged, as an unchanged spelling's", () => {
    const old = card([['application/json', report]], { name: 'getReport', response: report });
    const next = card([['application/json; charset=utf-8', thing]], { name: 'getReport', response: thing });
    expect(diffOperations('Reports', [old], [next])[0]).toMatchObject({
      responseChanged: true,
      responseContentTypesChanged: false,
      responseContentTypeChanges: [],
      classification: 'breaking',
    });
  });

  it('keeps two keys of one essence apart: a spelling that is gone is removed, one that appears is added', () => {
    const both = card(
      [
        ['application/json', report],
        ['application/json; charset=utf-8', report],
      ],
      { name: 'getReport', response: report },
    );
    const plain = card([['application/json', report]], { name: 'getReport', response: report });
    expect(diffOperations('Reports', [both], [plain])[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { added: [], removed: ['application/json; charset=utf-8'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
    expect(diffOperations('Reports', [plain], [both])[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { added: ['application/json; charset=utf-8'], removed: [], retyped: [], classification: 'additive' },
      ],
      classification: 'additive',
    });
  });

  it('pairs an unchanged spelling with itself before pairing by essence, so reordering two keys of one essence is no change', () => {
    const old = card(
      [
        ['application/json', report],
        ['application/json; charset=utf-8', thing],
      ],
      { name: 'getReport', response: report },
    );
    const next = card(
      [
        ['application/json; charset=utf-8', thing],
        ['application/json', report],
      ],
      { name: 'getReport', response: report },
    );
    expect(diffOperations('Reports', [old], [next])).toEqual([]);
  });

  it('folds case and parameters on error, default, range and alternate 2xx entries alike', () => {
    const pdf = contents([['application/pdf', binary]]);
    const withEntries = (json: string, html: string): Operation =>
      card([['application/pdf', binary]], {
        responseContents: pdf,
        successResponses: [
          { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
          {
            statusCode: 201,
            type: binary,
            contentTypes: ['application/pdf', html],
            contents: contents([
              ['application/pdf', binary],
              [html, string],
            ]),
          },
        ],
        errors: [{ statusCode: 404, type: problem, contentTypes: [json], contents: contents([[json, problem]]) }],
        defaultResponse: { type: problem, contentTypes: [json], contents: contents([[json, problem]]) },
        rangeResponses: [{ range: '5XX', type: problem, contentTypes: [json], contents: contents([[json, problem]]) }],
      });
    const old = withEntries('application/problem+json', 'text/html');
    const next = withEntries('Application/Problem+JSON; charset=utf-8', 'TEXT/HTML');
    expect(diffOperations('Pets', [old], [next])).toEqual([]);
    expect(diffOperations('Pets', [next], [old])).toEqual([]);
  });

  it('finds the entry a lone 2xx still is by essence, so a respelled key does not read as a format lost', () => {
    const lone = card([
      ['application/pdf', binary],
      ['text/html', string],
    ]);
    const pdf = contents([['application/pdf', binary]]);
    // A 200 offering PDF is added and the 201 only respells its keys: the lone
    // 201 pairs with the new 201, not with the new primary, so HTML is not
    // reported as lost.
    const withAdded200 = card([['application/pdf', binary]], {
      responseContents: pdf,
      successResponses: [
        { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        {
          statusCode: 201,
          type: binary,
          contentTypes: ['Application/PDF', 'TEXT/HTML'],
          contents: contents([
            ['Application/PDF', binary],
            ['TEXT/HTML', string],
          ]),
        },
      ],
    });
    expect(diffOperations('Pets', [lone], [withAdded200])).toEqual([]);
  });
});

describe('parser to differ — a secondary inline body under a respelled key (Greptile round 1)', () => {
  /** `getReport`: a `Report` JSON primary plus one secondary YAML inline object, under the given key and schema. */
  const report = (yamlKey: string, yamlProperties: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'Reports', version: '1' },
    paths: {
      '/report': {
        get: {
          operationId: 'getReport',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Report' } },
                [yamlKey]: { schema: { type: 'object', properties: yamlProperties } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Report: { type: 'object', properties: { id: { type: 'string' } } } } },
  });
  const diffDocuments = async (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'oagen-279-yaml-'));
    try {
      const oldPath = join(dir, 'old.json');
      const newPath = join(dir, 'new.json');
      writeFileSync(oldPath, JSON.stringify(before));
      writeFileSync(newPath, JSON.stringify(after));
      return diffSpecs(await parseSpec(oldPath), await parseSpec(newPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const title = { title: { type: 'string' } };

  it('reports no change when only the key respells itself: the model is named from the essence on both sides', async () => {
    const { changes, summary } = await diffDocuments(
      report('application/yaml', title),
      report('application/yaml; charset=utf-8', title),
    );
    expect(changes).toEqual([]);
    expect(summary.breaking).toBe(0);
  });

  it('still reports a schema change under a respelled key: the model is modified, and the body is not retyped', async () => {
    const { changes } = await diffDocuments(
      report('application/yaml', title),
      report('application/yaml; charset=utf-8', { ...title, summary: { type: 'string' } }),
    );
    // The model keeps its name, so the differ sees one modified model — not
    // a model removed and another added, and not a retyped media type.
    expect(changes.map((c) => c.kind)).toEqual(['model-modified']);
    expect(changes[0]).toMatchObject({
      kind: 'model-modified',
      name: 'GetReportApplicationYamlResponse',
      classification: 'additive',
    });
  });

  it('reports a body retyped under a respelled key when its type really changed', async () => {
    const before = report('application/yaml', title);
    const after = report('application/yaml; charset=utf-8', title);
    // The YAML body now points at the component instead of an inline object.
    after.paths['/report'].get.responses['200'].content['application/yaml; charset=utf-8'] = {
      schema: { $ref: '#/components/schemas/Report' },
    } as never;
    const { changes } = await diffDocuments(before, after);
    expect(changes.map((c) => c.kind).sort()).toEqual(['model-removed', 'operation-modified']);
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { added: [], removed: [], retyped: ['application/yaml; charset=utf-8'], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });
});
