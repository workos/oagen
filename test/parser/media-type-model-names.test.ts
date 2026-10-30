import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { mediaTypeNameFragment } from '../../src/utils/media-type.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-media-type-names-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });

/** `getReport`: a JSON primary body (`Report`) plus the given secondary media types under one `200`. */
const document = (secondary: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 'Reports', version: '1' },
  paths: {
    '/report': {
      get: {
        operationId: 'getReport',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } }, ...secondary },
          },
        },
      },
    },
  },
  components: { schemas: { Report: obj({ id: str }) } },
});

/** The types of the operation's secondary media types, in document order. */
function secondaryTypes(spec: ApiSpec): TypeRef[] {
  const [operation] = spec.services.flatMap((s) => s.operations);
  return (operation.responseContents ?? []).slice(1).map((c) => c.type);
}

function fieldsOf(spec: ApiSpec, name: string): string[] | undefined {
  return spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
}

describe('mediaTypeNameFragment', () => {
  it('names a media type from its essence: parameters stripped, case folded, a wildcard as Any', () => {
    expect(mediaTypeNameFragment('text/html')).toBe('TextHtml');
    expect(mediaTypeNameFragment('application/vnd.api+json')).toBe('ApplicationVndApiJson');
    expect(mediaTypeNameFragment('application/json')).toBe('ApplicationJson');
    expect(mediaTypeNameFragment('application/json; charset=utf-8')).toBe('ApplicationJson');
    expect(mediaTypeNameFragment('APPLICATION/JSON')).toBe('ApplicationJson');
    expect(mediaTypeNameFragment(' application/yaml ; charset=utf-8')).toBe('ApplicationYaml');
    expect(mediaTypeNameFragment('application/*')).toBe('ApplicationAny');
    expect(mediaTypeNameFragment('*/*')).toBe('AnyAny');
    expect(mediaTypeNameFragment('')).toBe('Content');
  });

  it('appends a key’s own parameters only when another key of its essence sits beside it, whatever the order', () => {
    const siblings = ['application/json', 'application/yaml', 'application/yaml; charset=utf-8'];
    expect(mediaTypeNameFragment('application/yaml', siblings)).toBe('ApplicationYaml');
    // A `charset` tells the key apart by being declared, not by its value (#389).
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', siblings)).toBe('ApplicationYamlCharset');
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', [...siblings].reverse())).toBe(
      'ApplicationYamlCharset',
    );
    // Alone among its essence, a parameterized key keeps the bare name.
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', ['application/json'])).toBe('ApplicationYaml');
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', ['application/yaml; charset=utf-8'])).toBe(
      'ApplicationYaml',
    );
    // Parameter case is folded; two parameterized spellings each carry their own.
    const versions = ['application/vnd.thing+json; version=1', 'application/vnd.thing+json; Version=2'];
    expect(mediaTypeNameFragment(versions[0], versions)).toBe('ApplicationVndThingJsonVersion1');
    expect(mediaTypeNameFragment(versions[1], versions)).toBe('ApplicationVndThingJsonVersion2');
    // Case-only siblings carry no parameters to tell them apart.
    expect(mediaTypeNameFragment('Application/YAML', ['application/yaml', 'Application/YAML'])).toBe('ApplicationYaml');
  });
});

describe('inline models for secondary media types are named by essence (issue #279, Greptile round 1)', () => {
  it('mints one model name for a key however it is spelled, so a respelled key keeps its model', async () => {
    const plain = await parseDocument(document({ 'application/yaml': { schema: obj({ title: str }) } }));
    const charset = await parseDocument(
      document({ 'Application/YAML; charset=utf-8': { schema: obj({ title: str }) } }),
    );
    expect(secondaryTypes(plain)).toEqual([{ kind: 'model', name: 'GetReportApplicationYamlResponse' }]);
    expect(secondaryTypes(charset)).toEqual(secondaryTypes(plain));
    expect(fieldsOf(charset, 'GetReportApplicationYamlResponse')).toEqual(['title']);
    // The key itself stays as written.
    expect(charset.services[0].operations[0].responseContentTypes).toEqual([
      'application/json',
      'Application/YAML; charset=utf-8',
    ]);
  });

  it('tells two spellings of one essence side by side apart by their parameters, whatever their order (Greptile round 2)', async () => {
    const yaml = { schema: obj({ title: str }) };
    const yamlCharset = { schema: obj({ summary: str }) };
    const inOrder = await parseDocument(
      document({ 'application/yaml': yaml, 'application/yaml; charset=utf-8': yamlCharset }),
    );
    const reversed = await parseDocument(
      document({ 'application/yaml; charset=utf-8': yamlCharset, 'application/yaml': yaml }),
    );
    expect(secondaryTypes(inOrder)).toEqual([
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
      { kind: 'model', name: 'GetReportApplicationYamlCharsetResponse' },
    ]);
    expect(secondaryTypes(reversed)).toEqual([
      { kind: 'model', name: 'GetReportApplicationYamlCharsetResponse' },
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
    ]);
    for (const spec of [inOrder, reversed]) {
      expect(fieldsOf(spec, 'GetReportApplicationYamlResponse')).toEqual(['title']);
      expect(fieldsOf(spec, 'GetReportApplicationYamlCharsetResponse')).toEqual(['summary']);
      // Every model minted for a secondary body is referenced, and every reference resolves.
      const minted = spec.models.filter((m) => m.name !== 'Report').map((m) => m.name);
      const referenced = secondaryTypes(spec).map((t) => (t.kind === 'model' ? t.name : ''));
      expect(minted.sort()).toEqual([...new Set(referenced)].sort());
    }

    // Equal shapes under two spellings are two models too: each key's name is its own.
    const same = await parseDocument(document({ 'application/yaml': yaml, 'application/yaml; charset=utf-8': yaml }));
    expect(secondaryTypes(same)).toEqual([
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
      { kind: 'model', name: 'GetReportApplicationYamlCharsetResponse' },
    ]);
  });

  it('leaves two keys that differ only in case to the registry: the second steps to the status-code-qualified name', async () => {
    const spec = await parseDocument(
      document({
        'application/yaml': { schema: obj({ title: str }) },
        'Application/YAML': { schema: obj({ summary: str }) },
      }),
    );
    expect(secondaryTypes(spec)).toEqual([
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
      { kind: 'model', name: 'GetReportApplicationYamlResponse200' },
    ]);
    expect(fieldsOf(spec, 'GetReportApplicationYamlResponse200')).toEqual(['summary']);
  });
});

describe('a model name stays put under edits `oagen diff` reads as no change or additive (issue #389)', () => {
  type Keys = Array<[key: string, property: string]>;
  const note = { schema: { $ref: '#/components/schemas/Note' } };
  /** Each key's body: an inline object with the one `string` property named. */
  const bodies = (keys: Keys) =>
    Object.fromEntries(keys.map(([key, property]) => [key, { schema: obj({ [property]: str }) }]));
  const notes = (paths: Record<string, unknown>, webhooks?: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'Notes', version: '1' },
    paths,
    ...(webhooks && { webhooks }),
    components: { schemas: { Note: obj({ id: str, title: str }) } },
  });
  /** The issue's `GET /notes` (`listNotes`): `Note` under `application/json`, then `keys`, on the response at `code`. */
  const listNotes = (keys: Keys, code = '200') =>
    notes({
      '/notes': {
        get: {
          operationId: 'listNotes',
          responses: {
            '200': { description: 'OK', content: { 'application/json': note } },
            [code]: { description: 'OK', content: { 'application/json': note, ...bodies(keys) } },
          },
        },
      },
    });
  /** `POST /notes` (`createNote`) sending `Note` as `application/json`, or `keys`. */
  const createNote = (keys: Keys) =>
    notes({
      '/notes': {
        post: {
          operationId: 'createNote',
          requestBody: { content: { 'application/json': note, ...bodies(keys) } },
          responses: { '204': { description: 'created' } },
        },
      },
    });
  /** A `noteAdded` webhook delivering `Note` as `application/json`, or `keys`. */
  const noteAdded = (keys: Keys) =>
    notes(
      {},
      {
        noteAdded: {
          post: {
            requestBody: { content: { 'application/json': note, ...bodies(keys) } },
            responses: { '200': { description: 'received' } },
          },
        },
      },
    );

  /** Each change as the issue's script prints it. */
  const diff = async (before: Record<string, unknown>, after: Record<string, unknown>) =>
    diffSpecs(await parseDocument(before), await parseDocument(after)).changes.map((change) => {
      const { classification, kind, name, operationName } = change as typeof change & {
        name?: string;
        operationName?: string;
      };
      return `${classification} ${kind} ${name ?? operationName}`;
    });
  /** The model each key's body is typed by, keyed by the key: every entry of every response, request body and webhook. */
  const namesOf = async (document: Record<string, unknown>): Promise<Record<string, string>> => {
    const spec = await parseDocument(document);
    const entries = [
      ...spec.services
        .flatMap((s) => s.operations)
        .flatMap((op) => [
          ...(op.successResponses ?? []).flatMap((r) => r.contents ?? []),
          ...(op.responseContents ?? []),
          ...op.errors.flatMap((e) => e.contents ?? []),
          ...(op.rangeResponses ?? []).flatMap((r) => r.contents ?? []),
          ...(op.requestBodyContents ?? []),
        ]),
      ...(spec.webhooks ?? []).flatMap((w) => w.requestBodyContents ?? []),
    ];
    return Object.fromEntries(
      entries
        .filter(({ type }) => type.kind === 'model' && type.name !== 'Note')
        .map(({ contentType, type }) => [
          contentType,
          `${(type as { name: string }).name} { ${fieldsOf(spec, (type as { name: string }).name)} }`,
        ]),
    );
  };

  it('adding a key of another parameter leaves an unchanged sibling its model: additive, as before #330 (case 1)', async () => {
    const before = listNotes([['application/yaml; charset=utf-8', 'title']]);
    const after = listNotes([
      ['application/yaml; charset=utf-8', 'title'],
      ['application/yaml; version=2', 'summary'],
    ]);

    expect(await namesOf(after)).toEqual({
      'application/yaml; charset=utf-8': 'ListNotesApplicationYamlResponse { title }',
      'application/yaml; version=2': 'ListNotesApplicationYamlVersion2Response { summary }',
    });
    expect(await diff(before, after)).toEqual([
      'additive model-added ListNotesApplicationYamlVersion2Response',
      'additive operation-modified listNotes',
    ]);
  });

  it('reordering two keys that differ only in case swaps no models: no change (case 2)', async () => {
    const keys: Keys = [
      ['application/yaml', 'title'],
      ['Application/YAML', 'summary'],
    ];
    const before = listNotes(keys);
    const after = listNotes([...keys].reverse());

    // The key with lower case takes the bare name, wherever it is written.
    for (const document of [before, after]) {
      expect(await namesOf(document)).toEqual({
        'application/yaml': 'ListNotesApplicationYamlResponse { title }',
        'Application/YAML': 'ListNotesApplicationYamlResponse200 { summary }',
      });
    }
    expect(await diff(before, after)).toEqual([]);
    expect(await diff(after, before)).toEqual([]);
  });

  it.each([
    ['a `charset` edit', 'application/yaml; charset=utf-8', 'application/yaml; charset=iso-8859-1', 'Charset'],
    ['a parameter reorder', 'application/yaml; a=1; b=2', 'application/yaml; b=2; a=1', 'A1B2'],
    ['a dropped `charset`', 'application/yaml; version=2; charset=utf-8', 'application/yaml; version=2', 'Version2'],
  ])('%s on a key beside `application/yaml` renames no model: no change (case 3)', async (_, from, to, qualifier) => {
    const before = listNotes([
      ['application/yaml', 'title'],
      [from, 'summary'],
    ]);
    const after = listNotes([
      ['application/yaml', 'title'],
      [to, 'summary'],
    ]);

    for (const [document, key] of [
      [before, from],
      [after, to],
    ] as const) {
      expect(await namesOf(document)).toEqual({
        'application/yaml': 'ListNotesApplicationYamlResponse { title }',
        [key]: `ListNotesApplicationYaml${qualifier}Response { summary }`,
      });
    }
    expect(await diff(before, after)).toEqual([]);
  });

  it('a `charset` edit on a request body renames no model: no change (case 3)', async () => {
    const before = createNote([
      ['application/yaml', 'title'],
      ['application/yaml; charset=utf-8', 'summary'],
    ]);
    const after = createNote([
      ['application/yaml', 'title'],
      ['application/yaml; charset=latin1', 'summary'],
    ]);

    expect(await namesOf(before)).toEqual({
      'application/yaml': 'CreateNoteApplicationYamlRequest { title }',
      'application/yaml; charset=utf-8': 'CreateNoteApplicationYamlCharsetRequest { summary }',
    });
    expect(await namesOf(after)).toEqual({
      'application/yaml': 'CreateNoteApplicationYamlRequest { title }',
      'application/yaml; charset=latin1': 'CreateNoteApplicationYamlCharsetRequest { summary }',
    });
    expect(await diff(before, after)).toEqual([]);
  });

  it('adding a key of another parameter leaves an inline error body at a status code its model: additive', async () => {
    const before = listNotes([['application/yaml; charset=utf-8', 'title']], '404');
    const after = listNotes(
      [
        ['application/yaml; charset=utf-8', 'title'],
        ['application/yaml; version=2', 'summary'],
      ],
      '404',
    );

    expect(await namesOf(after)).toEqual({
      'application/yaml; charset=utf-8': 'ListNotesError404ApplicationYaml { title }',
      'application/yaml; version=2': 'ListNotesError404ApplicationYamlVersion2 { summary }',
    });
    expect(await diff(before, after)).toEqual([
      'additive model-added ListNotesError404ApplicationYamlVersion2',
      'additive operation-modified listNotes',
    ]);
  });

  it('a `charset` edit on an inline error body at a range renames no model: no change', async () => {
    const keys = (charset: string): Keys => [
      ['application/yaml', 'title'],
      [`application/yaml; charset=${charset}`, 'summary'],
    ];
    const before = listNotes(keys('utf-8'), '4XX');
    const after = listNotes(keys('iso-8859-1'), '4XX');

    expect(await namesOf(before)).toEqual({
      'application/yaml': 'ListNotesError4XxApplicationYaml { title }',
      'application/yaml; charset=utf-8': 'ListNotesError4XxApplicationYamlCharset { summary }',
    });
    expect(await namesOf(after)).toEqual({
      'application/yaml': 'ListNotesError4XxApplicationYaml { title }',
      'application/yaml; charset=iso-8859-1': 'ListNotesError4XxApplicationYamlCharset { summary }',
    });
    expect(await diff(before, after)).toEqual([]);
  });

  it('neither a `charset` edit nor a reorder of case-only keys renames a webhook payload model', async () => {
    const before = noteAdded([
      ['application/yaml', 'title'],
      ['application/yaml; charset=utf-8', 'summary'],
      ['APPLICATION/YAML', 'body'],
    ]);
    const after = noteAdded([
      ['APPLICATION/YAML', 'body'],
      ['application/yaml; charset=utf-16', 'summary'],
      ['application/yaml', 'title'],
    ]);

    expect(await namesOf(before)).toEqual({
      'application/yaml': 'NoteAddedApplicationYamlPayload { title }',
      'application/yaml; charset=utf-8': 'NoteAddedApplicationYamlCharsetPayload { summary }',
      'APPLICATION/YAML': 'NoteAddedApplicationYamlPayload2 { body }',
    });
    expect(await namesOf(after)).toEqual({
      'APPLICATION/YAML': 'NoteAddedApplicationYamlPayload2 { body }',
      'application/yaml; charset=utf-16': 'NoteAddedApplicationYamlCharsetPayload { summary }',
      'application/yaml': 'NoteAddedApplicationYamlPayload { title }',
    });
    expect(await diff(before, after)).toEqual([]);
  });

  it('the same reorder renames no request body model either', async () => {
    const keys: Keys = [
      ['application/yaml', 'title'],
      ['APPLICATION/YAML', 'body'],
    ];
    const before = createNote(keys);
    const after = createNote([...keys].reverse());

    for (const document of [before, after]) {
      expect(await namesOf(document)).toEqual({
        'application/yaml': 'CreateNoteApplicationYamlRequest { title }',
        'APPLICATION/YAML': 'CreateNoteApplicationYamlRequest2 { body }',
      });
    }
    expect(await diff(before, after)).toEqual([]);
  });
});
