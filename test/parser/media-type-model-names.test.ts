import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { mediaTypeNameFragment } from '../../src/utils/media-type.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

async function parseDocument(
  document: Record<string, unknown>,
  options?: Parameters<typeof parseSpec>[1],
): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-media-type-names-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file, options);
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

  it.each<[string, [lower: string, upper: string], [lower: string, upper: string], string]>([
    [
      'quoting a value',
      ['application/yaml; profile=print', 'Application/YAML; profile=print'],
      ['application/yaml; profile=print', 'Application/YAML; profile="print"'],
      'ProfilePrint',
    ],
    [
      'dropping a space',
      ['application/yaml; profile=print', 'Application/YAML; profile=print'],
      ['application/yaml;profile=print', 'Application/YAML; profile=print'],
      'ProfilePrint',
    ],
    [
      'reordering the parameters',
      ['application/yaml; b=2; a=1', 'Application/YAML; b=2; a=1'],
      ['application/yaml; b=2; a=1', 'Application/YAML; a=1; b=2'],
      'A1B2',
    ],
  ])(
    '%s on one of two keys that differ only in case swaps no models: no change (Greptile)',
    async (_, from, to, qualifier) => {
      const keys = ([lower, upper]: [string, string]): Keys => [
        [lower, 'title'],
        [upper, 'summary'],
      ];
      const [before, after] = [listNotes(keys(from)), listNotes(keys(to))];

      // The key with lower case takes the bare name, however either is quoted, spaced or ordered.
      for (const [document, [lower, upper]] of [
        [before, from],
        [after, to],
      ] as const) {
        expect(await namesOf(document)).toEqual({
          [lower]: `ListNotesApplicationYaml${qualifier}Response { title }`,
          [upper]: `ListNotesApplicationYaml${qualifier}Response200 { summary }`,
        });
      }
      expect(await diff(before, after)).toEqual([]);
    },
  );

  it("a quote or a space on one of two keys alike but for their parameters' order swaps no models: no change (Greptile round 2)", async () => {
    const first = 'application/yaml; b=2; a=1';
    const before = listNotes([
      [first, 'title'],
      ['application/yaml; a=1; b=2', 'summary'],
    ]);
    for (const respelled of ['application/yaml; a=1; b="2"', 'application/yaml;a=1;b=2']) {
      const after = listNotes([
        [first, 'title'],
        [respelled, 'summary'],
      ]);

      // Nothing but syntax tells the two apart, so the one written first takes the bare name.
      for (const [document, key] of [
        [before, 'application/yaml; a=1; b=2'],
        [after, respelled],
      ] as const) {
        expect(await namesOf(document), key).toEqual({
          [first]: 'ListNotesApplicationYamlA1B2Response { title }',
          [key]: 'ListNotesApplicationYamlA1B2Response200 { summary }',
        });
      }
      expect(await diff(before, after), respelled).toEqual([]);
    }
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
      'application/yaml; charset=utf-8': 'OptionalErrorBodyWithTitleWithoutMessage { title }',
      'application/yaml; version=2': 'OptionalErrorBodyWithSummaryWithoutMessage { summary }',
    });
    expect(await diff(before, after)).toEqual([
      'additive model-added OptionalErrorBodyWithSummaryWithoutMessage',
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
      'application/yaml': 'OptionalErrorBodyWithTitleWithoutMessage { title }',
      'application/yaml; charset=utf-8': 'OptionalErrorBodyWithSummaryWithoutMessage { summary }',
    });
    expect(await namesOf(after)).toEqual({
      'application/yaml': 'OptionalErrorBodyWithTitleWithoutMessage { title }',
      'application/yaml; charset=iso-8859-1': 'OptionalErrorBodyWithSummaryWithoutMessage { summary }',
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

  describe('edits that still swap or rename a model, as `ir-types.md` and `cli.md` document (#517 review)', () => {
    it.each<[string, (keys: Keys) => Record<string, unknown>, string, string, string]>([
      [
        'response',
        listNotes,
        'ListNotesApplicationYamlResponse',
        'ListNotesApplicationYamlResponse200',
        'operation-modified listNotes',
      ],
      [
        'request body',
        createNote,
        'CreateNoteApplicationYamlRequest',
        'CreateNoteApplicationYamlRequest2',
        'operation-modified createNote',
      ],
      [
        'webhook payload',
        noteAdded,
        'NoteAddedApplicationYamlPayload',
        'NoteAddedApplicationYamlPayload2',
        'webhook-modified noteAdded',
      ],
    ])(
      'a case edit to one of two case-only keys swaps their models on a %s: breaking',
      async (_, build, bare, stepped, site) => {
        const before = build([
          ['application/yaml', 'title'],
          ['Application/YAML', 'summary'],
        ]);
        const after = build([
          ['APPLICATION/YAML', 'title'],
          ['Application/YAML', 'summary'],
        ]);

        // The order is read from the keys' case, so the edit moves `Application/YAML` first.
        expect(await namesOf(before)).toEqual({
          'application/yaml': `${bare} { title }`,
          'Application/YAML': `${stepped} { summary }`,
        });
        expect(await namesOf(after)).toEqual({
          'APPLICATION/YAML': `${stepped} { title }`,
          'Application/YAML': `${bare} { summary }`,
        });
        expect(await diff(before, after)).toEqual([
          `breaking model-modified ${bare}`,
          `breaking model-modified ${stepped}`,
          `breaking ${site}`,
        ]);
      },
    );

    it('a `charset` edit to one of two keys that differ in nothing else swaps their models: breaking', async () => {
      const utf8 = 'application/yaml; charset=utf-8';
      const before = listNotes([
        [utf8, 'title'],
        ['application/yaml; charset=latin1', 'summary'],
      ]);
      const after = listNotes([
        [utf8, 'title'],
        ['application/yaml; charset=windows-1252', 'summary'],
      ]);

      // Both carry `Charset` without its value, so the value is all that orders them:
      // `latin1` before `utf-8`, `utf-8` before `windows-1252`.
      expect(await namesOf(before)).toEqual({
        [utf8]: 'ListNotesApplicationYamlCharsetResponse200 { title }',
        'application/yaml; charset=latin1': 'ListNotesApplicationYamlCharsetResponse { summary }',
      });
      expect(await namesOf(after)).toEqual({
        [utf8]: 'ListNotesApplicationYamlCharsetResponse { title }',
        'application/yaml; charset=windows-1252': 'ListNotesApplicationYamlCharsetResponse200 { summary }',
      });
      expect(await diff(before, after)).toEqual([
        'breaking model-modified ListNotesApplicationYamlCharsetResponse',
        'breaking model-modified ListNotesApplicationYamlCharsetResponse200',
        'breaking operation-modified listNotes',
      ]);
    });

    it('reordering two keys that differ only in syntax swaps their models, as on the base: breaking', async () => {
      const keys: Keys = [
        ['application/yaml; b=2; a=1', 'title'],
        ['application/yaml; a=1; b=2', 'summary'],
      ];
      const before = listNotes(keys);
      const after = listNotes([...keys].reverse());

      // Nothing but syntax tells them apart, so the one written first takes the bare name.
      expect(await namesOf(before)).toEqual({
        'application/yaml; b=2; a=1': 'ListNotesApplicationYamlA1B2Response { title }',
        'application/yaml; a=1; b=2': 'ListNotesApplicationYamlA1B2Response200 { summary }',
      });
      expect(await namesOf(after)).toEqual({
        'application/yaml; a=1; b=2': 'ListNotesApplicationYamlA1B2Response { summary }',
        'application/yaml; b=2; a=1': 'ListNotesApplicationYamlA1B2Response200 { title }',
      });
      expect(await diff(before, after)).toEqual([
        'breaking model-modified ListNotesApplicationYamlA1B2Response',
        'breaking model-modified ListNotesApplicationYamlA1B2Response200',
        'breaking operation-modified listNotes',
      ]);
    });

    it('adding a key without parameters beside a `charset` key and a `version` key renames the `charset` key’s model: breaking', async () => {
      const charset: [string, string] = ['application/yaml; charset=utf-8', 'title'];
      const version: [string, string] = ['application/yaml; version=2', 'summary'];
      const bare: [string, string] = ['application/yaml', 'x'];

      // A `charset` reaches the name only beside a key with the same other parameters, which `application/yaml` is.
      expect(await namesOf(listNotes([charset, version]))).toEqual({
        'application/yaml; charset=utf-8': 'ListNotesApplicationYamlResponse { title }',
        'application/yaml; version=2': 'ListNotesApplicationYamlVersion2Response { summary }',
      });
      expect(await namesOf(listNotes([charset, version, bare]))).toEqual({
        'application/yaml; charset=utf-8': 'ListNotesApplicationYamlCharsetResponse { title }',
        'application/yaml; version=2': 'ListNotesApplicationYamlVersion2Response { summary }',
        'application/yaml': 'ListNotesApplicationYamlResponse { x }',
      });
      expect(await diff(listNotes([charset, version]), listNotes([charset, version, bare]))).toEqual([
        'additive model-added ListNotesApplicationYamlCharsetResponse',
        'breaking model-modified ListNotesApplicationYamlResponse',
        'additive operation-modified listNotes',
      ]);

      // The reverse edit ends in the same three keys, and only one of the two can rename nothing: this one.
      expect(await diff(listNotes([bare, version]), listNotes([bare, version, charset]))).toEqual([
        'additive model-added ListNotesApplicationYamlCharsetResponse',
        'additive operation-modified listNotes',
      ]);
    });
  });
});

describe("a later 2xx's secondary body is named for its status code, as its primary body is (issue #538)", () => {
  const yaml = (properties: Record<string, unknown>) => ({ schema: obj(properties) });
  /** `POST /pets` (`createPet`) with the given responses, each `{ description, content }` as written. */
  const createPet = (
    openapi: string,
    responses: Record<string, unknown>,
    components: Record<string, unknown> = {},
  ) => ({
    openapi,
    info: { title: 'Pets', version: '1' },
    paths: { '/pets': { post: { operationId: 'createPet', responses } } },
    components,
  });
  /** A response with `{ id }` under `application/json` and the given properties under `application/yaml`. */
  const jsonAndYaml = (yamlProperties: Record<string, unknown>, description = 'ok') => ({
    description,
    content: { 'application/json': { schema: obj({ id: str }) }, 'application/yaml': yaml(yamlProperties) },
  });
  const typeName = (type: TypeRef) => (type.kind === 'model' || type.kind === 'enum' ? type.name : type.kind);
  const operationOf = (spec: ApiSpec) => spec.services.flatMap((s) => s.operations)[0];
  /** Each success entry's media types with the model each is typed by. */
  const contentsOf = (spec: ApiSpec) =>
    operationOf(spec).successResponses!.map(
      ({ contents, statusCode }) =>
        `${statusCode}: ${(contents ?? []).map(({ contentType, type }) => `${contentType} → ${typeName(type)}`).join(', ')}`,
    );
  /** Each success entry's `application/yaml` body, as the issue's script prints it. */
  const yamlOf = (spec: ApiSpec) =>
    operationOf(spec).successResponses!.map(({ contents, statusCode }) => {
      const body = contents?.find(({ contentType }) => contentType === 'application/yaml');
      return `${statusCode}: ${body ? typeName(body.type) : 'none'}`;
    });
  const modelsOf = (spec: ApiSpec) =>
    spec.models.map(({ fields, name }) => `${name} { ${fields.map((f) => f.name).join(', ')} }`);
  /** Each change as the issue's script prints it, with the retyped media types, and the exit code `oagen diff` ends with. */
  const diff = (before: ApiSpec, after: ApiSpec) => {
    const { changes, summary } = diffSpecs(before, after);
    return {
      changes: changes.map((change) => {
        const { classification, kind, name, operationName, responseContentTypeChanges } = change as typeof change & {
          name?: string;
          operationName?: string;
          responseContentTypeChanges?: Array<{ statusCode?: number; retyped?: string[] }>;
        };
        const retyped = (responseContentTypeChanges ?? []).flatMap(({ retyped = [], statusCode }) =>
          retyped.map((contentType) => `${statusCode} retyped ${contentType}`),
        );
        return [classification, kind, name ?? operationName, ...retyped].join(' ');
      }),
      exit: summary.breaking > 0 ? 2 : summary.modified + summary.removed + summary.added > 0 ? 1 : 0,
    };
  };

  describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
    const YAML = 'CreatePetApplicationYamlResponse';
    const same = (responses: Record<string, unknown> = {}, components?: Record<string, unknown>) =>
      createPet(
        openapi,
        { '200': jsonAndYaml({ id: str }), '201': jsonAndYaml({ id: str }, 'created'), ...responses },
        components,
      );

    it('the issue repro: the 201 YAML body is `CreatePetApplicationYamlResponse201` in every document, so an edit to either body is additive', async () => {
      const before = await parseDocument(same());
      const tag201 = await parseDocument(same({ '201': jsonAndYaml({ id: str, tag: str }, 'created') }));
      const tag200 = await parseDocument(same({ '200': jsonAndYaml({ id: str, tag: str }) }));

      for (const spec of [before, tag201, tag200]) {
        expect(yamlOf(spec)).toEqual([`200: ${YAML}`, `201: ${YAML}201`]);
      }
      const json = ['CreatePetResponse { id }', 'CreatePetResponse201 { id }'];
      expect(modelsOf(before)).toEqual([...json, `${YAML} { id }`, `${YAML}201 { id }`]);
      expect(modelsOf(tag201)).toEqual([...json, `${YAML} { id }`, `${YAML}201 { id, tag }`]);
      expect(modelsOf(tag200)).toEqual([...json, `${YAML} { id, tag }`, `${YAML}201 { id }`]);
      expect(diff(before, tag201)).toEqual({ changes: [`additive model-modified ${YAML}201`], exit: 1 });
      expect(diff(before, tag200)).toEqual({ changes: [`additive model-modified ${YAML}`], exit: 1 });
    });

    it('names a `+json` secondary body for the 201 too, and the YAML body beside a `+json` primary', async () => {
      const vendor = (description = 'ok') => ({
        description,
        content: {
          'application/json': { schema: obj({ id: str }) },
          'application/vnd.pet+json': { schema: obj({ name: str }) },
        },
      });
      const secondary = await parseDocument(createPet(openapi, { '200': vendor(), '201': vendor('created') }));
      expect(contentsOf(secondary)).toEqual([
        '200: application/json → CreatePetResponse, application/vnd.pet+json → CreatePetApplicationVndPetJsonResponse',
        '201: application/json → CreatePetResponse201, application/vnd.pet+json → CreatePetApplicationVndPetJsonResponse201',
      ]);

      // With no `application/json`, the `+json` body is the primary pick and
      // the YAML body beside it the secondary.
      const primary = (description = 'ok') => ({
        description,
        content: { 'application/vnd.pet+json': { schema: obj({ id: str }) }, 'application/yaml': yaml({ id: str }) },
      });
      const vendorPrimary = await parseDocument(createPet(openapi, { '200': primary(), '201': primary('created') }));
      expect(contentsOf(vendorPrimary)).toEqual([
        `200: application/vnd.pet+json → CreatePetResponse, application/yaml → ${YAML}`,
        `201: application/vnd.pet+json → CreatePetResponse201, application/yaml → ${YAML}201`,
      ]);
    });

    it('shares a later body with an earlier later body of its shape, never with the primary', async () => {
      const spec = await parseDocument(
        same({
          '202': jsonAndYaml({ id: str }, 'accepted'),
          '203': jsonAndYaml({ id: str, eta: str }, 'non-authoritative'),
          '206': jsonAndYaml({ id: str, eta: str }, 'partial'),
        }),
      );

      expect(yamlOf(spec)).toEqual([
        `200: ${YAML}`,
        `201: ${YAML}201`,
        `202: ${YAML}201`,
        `203: ${YAML}203`,
        `206: ${YAML}203`,
      ]);
      expect(modelsOf(spec)).toEqual([
        'CreatePetResponse { id }',
        'CreatePetResponse201 { id }',
        `${YAML} { id }`,
        `${YAML}201 { id }`,
        `${YAML}203 { id, eta }`,
      ]);
    });

    it('names the nested models and inline enums of a later body under its stem, whatever the 200 declares', async () => {
      const nested = { owner: obj({ id: str }), status: { type: 'string', enum: ['a', 'b'] } };
      const spec = await parseDocument(same({ '200': jsonAndYaml(nested), '201': jsonAndYaml(nested, 'created') }));
      const fieldTypes = (name: string) =>
        spec.models.find((m) => m.name === name)!.fields.map((f) => `${f.name}: ${typeName(f.type)}`);

      expect(modelsOf(spec)).toEqual([
        'CreatePetResponse { id }',
        'CreatePetResponse201 { id }',
        `${YAML} { owner, status }`,
        `${YAML}Owner { id }`,
        `${YAML}201 { owner, status }`,
        `${YAML}201Owner { id }`,
      ]);
      expect(fieldTypes(YAML)).toEqual([`owner: ${YAML}Owner`, `status: ${YAML}Status`]);
      expect(fieldTypes(`${YAML}201`)).toEqual([`owner: ${YAML}201Owner`, `status: ${YAML}201Status`]);
      expect(spec.enums.map((e) => `${e.name} [${e.values.map((v) => v.value).join(', ')}]`)).toEqual([
        `${YAML}Status [a, b]`,
        `${YAML}201Status [a, b]`,
      ]);
    });

    it('gives the same names whichever status code the document declares first', async () => {
      const forward = await parseDocument(same());
      const reversed = await parseDocument(
        createPet(openapi, { '201': jsonAndYaml({ id: str }, 'created'), '200': jsonAndYaml({ id: str }) }),
      );

      expect(yamlOf(reversed)).toEqual(yamlOf(forward));
      expect(modelsOf(reversed)).toEqual(modelsOf(forward));
      expect(diff(forward, reversed)).toEqual({ changes: [], exit: 0 });
    });

    it('keeps the bare name for the primary status code, the lowest 2xx with a typed body, not for the 200', async () => {
      const spec = await parseDocument(
        createPet(openapi, {
          '200': { description: 'no body' },
          '201': jsonAndYaml({ id: str }, 'created'),
          '202': jsonAndYaml({ id: str }, 'accepted'),
        }),
      );

      expect(operationOf(spec).responseStatusCode).toBe(201);
      expect(yamlOf(spec)).toEqual(['200: none', `201: ${YAML}`, `202: ${YAML}202`]);
    });

    it('steps a later body past a schema that owns its status-coded name by number, never onto the primary', async () => {
      const owned = (...names: string[]) => ({
        schemas: Object.fromEntries(names.map((name) => [name, obj({ other: str })])),
      });
      const one = await parseDocument(same({}, owned(`${YAML}201`)));
      expect(yamlOf(one)).toEqual([`200: ${YAML}`, `201: ${YAML}2`]);
      expect(modelsOf(one)).toContain(`${YAML}2 { id }`);

      // The bare name, `…Response200` and `…Response201` all owned: the 200
      // steps to `…Response2`, and the 201, the same shape, past it to
      // `…Response3` rather than onto the 200's model.
      const all = await parseDocument(same({}, owned(YAML, `${YAML}200`, `${YAML}201`)));
      expect(yamlOf(all)).toEqual([`200: ${YAML}2`, `201: ${YAML}3`]);
      expect(modelsOf(all)).toEqual(
        expect.arrayContaining([
          `${YAML} { other }`,
          `${YAML}200 { other }`,
          `${YAML}201 { other }`,
          `${YAML}2 { id }`,
          `${YAML}3 { id }`,
        ]),
      );
    });

    it('leaves a component response, a 3xx, an error and a default entry named as before', async () => {
      const code = { 'application/json': { schema: obj({ code: str }) }, 'application/yaml': yaml({ code: str }) };
      const spec = await parseDocument(
        same(
          {
            '201': { $ref: '#/components/responses/Card' },
            '302': { description: 'moved', content: { 'application/yaml': yaml({ id: str }) } },
            '404': { description: 'missing', content: code },
            default: { description: 'other', content: code },
          },
          {
            responses: {
              Card: {
                description: 'card',
                content: {
                  'application/json': { schema: obj({ text: str }) },
                  'application/yaml': yaml({ text: str }),
                },
              },
            },
          },
        ),
        // The error bodies as the parser names them, before the collapse pass folds them into one model.
        { collapseErrorBodies: false },
      );
      const op = operationOf(spec);

      expect(contentsOf(spec)).toEqual([
        `200: application/json → CreatePetResponse, application/yaml → ${YAML}`,
        // The component's wherever it is mounted, never `CardApplicationYamlResponse201`.
        '201: application/json → CardResponse, application/yaml → CardApplicationYamlResponse',
        // A 3xx entry is not a later 2xx: its body shares the 200's model as before.
        `302: application/yaml → ${YAML}`,
      ]);
      expect(op.errors.map((e) => e.contents!.map((c) => typeName(c.type)).join(', '))).toEqual([
        'CreatePetError404, CreatePetError404ApplicationYaml',
      ]);
      expect(op.defaultResponse!.contents!.map((c) => typeName(c.type))).toEqual([
        'CreatePetDefaultResponse',
        'CreatePetDefaultApplicationYamlResponse',
      ]);
    });
  });
});
