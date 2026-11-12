import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

// #612: a shared error body's inline enum — an integer `status: { enum:
// [404, 410] }`, a `number`, a string enum under array items — kept the name
// the parser minted for the group's first member by per-operation model
// name (`ListPetsError404Status`), so adding an operation whose name sorted
// first swapped the enum for a new one and `oagen diff` reported it as
// breaking. Every inline enum a shared body's field lists is now named from
// the field and its values (`ErrorBodyStatus404Or410`, `ErrorBodyCodesAOrB`),
// one enum per field name and value set, so the name depends on nothing
// else in the document and adding an operation never renames one — a bare
// `ErrorBodyStatus` was tried first and dropped on review, since a second
// value set, a string-pinned `status` or an `errorCode` beside `error_code`
// each moved it (PR #648 review).

type Doc = Record<string, unknown>;
const VERSIONS = ['3.0.3', '3.1.0'] as const;
const str = { type: 'string' };
const status = { type: 'integer', enum: [404, 410] };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)): Doc => ({
  type: 'object',
  properties,
  required,
});
const statusBody = obj({ message: str, status });
const json = (schema: Doc) => ({ 'application/json': { schema } });
/** An operation answering `204`, with the given error responses. */
const op = (operationId: string, errors: Doc): Doc => ({
  operationId,
  responses: { '204': { description: 'ok' }, ...errors },
});
/** The issue's `404` with an inline body. */
const nf = (schema: Doc): Doc => ({ '404': { description: 'nf', content: json(schema) } });
/** `GET /pets` (`listPets`) with the given error responses. */
const pets = (errors: Doc, operationId = 'listPets'): Doc => ({ '/pets': { get: op(operationId, errors) } });
/** `GET /notes` (`listNotes`) with the given error responses. */
const notes = (errors: Doc, operationId = 'listNotes'): Doc => ({ '/notes': { get: op(operationId, errors) } });
const doc = (openapi: string, paths: Doc, schemas?: Doc): Doc => ({
  openapi,
  info: { title: '612', version: '1' },
  paths,
  ...(schemas && { components: { schemas } }),
});

async function withFile<T>(spec: Doc, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-612-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await use(file);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

const parse = (spec: Doc): Promise<ApiSpec> => withFile(spec, (file) => parseSpec(file));

async function parseWithoutWarnings(spec: Doc): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(spec);
    expect(warn.mock.calls).toEqual([]);
    return ir;
  } finally {
    warn.mockRestore();
  }
}

/** Parse, expecting exactly one `console.warn` per pattern, in order. */
async function parseWithWarnings(spec: Doc, patterns: readonly RegExp[]): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(spec);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(patterns.length);
    patterns.forEach((pattern, i) => expect(messages[i]).toMatch(pattern));
    return ir;
  } finally {
    warn.mockRestore();
  }
}

/** The exit code `oagen diff --old … --new …` ends with. */
async function diffExitCode(oldSpec: Doc, newSpec: Doc): Promise<number> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await withFile(oldSpec, (oldFile) =>
      withFile(newSpec, async (newFile) => {
        const err: unknown = await diffCommand({ old: oldFile, new: newFile }).catch((e: unknown) => e);
        return (err as { exitCode: number }).exitCode;
      }),
    );
  } finally {
    log.mockRestore();
  }
}

const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();
const enumNames = (spec: ApiSpec): string[] => spec.enums.map((e) => e.name).sort();
const enumValues = (spec: ApiSpec, name: string): (string | number)[] | undefined =>
  spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);
const fieldType = (spec: ApiSpec, model: string, field: string): TypeRef | undefined =>
  spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;
const changes = (a: ApiSpec, b: ApiSpec): string[] =>
  diffSpecs(a, b).changes.map((change) => {
    const name = 'name' in change && typeof change.name === 'string' ? change.name : '';
    return `${change.classification} ${change.kind} ${name}`.trim();
  });

/** Every inline enum a model's field references is lifted once under that name with those values (a shared component enum keeps its declared order), and none keeps an operation's name. */
function expectEnumsSound(spec: ApiSpec): void {
  const sorted = (values: readonly (string | number)[] | undefined): (string | number)[] | undefined =>
    values && [...values].sort((a, b) => String(a).localeCompare(String(b)));
  const lifted = new Map(spec.enums.map((e) => [e.name, sorted(e.values.map((v) => v.value))]));
  expect(new Set(lifted.keys()).size).toBe(spec.enums.length);
  for (const model of spec.models) {
    for (const field of model.fields) {
      walkTypeRef(field.type, {
        enum: (ref) => {
          expect(lifted.get(ref.name), `${model.name}.${field.name} → ${ref.name}`).toEqual(sorted(ref.values));
          expect(ref.name).not.toMatch(/^List(Pets|Notes)/);
        },
      });
    }
  }
}

describe('#612', () => {
  it.each(VERSIONS)(
    "the issue's repro: the shared body's `status` keeps one `ErrorBodyStatus404Or410` when `listNotes` is added, and the diff is additive (exit 1), under OAS %s",
    async (version) => {
      const oldDoc = doc(version, pets(nf(statusBody)));
      const newDoc = doc(version, { ...pets(nf(statusBody)), ...notes(nf(statusBody)) });
      const oldSpec = await parseWithoutWarnings(oldDoc);
      const newSpec = await parseWithoutWarnings(newDoc);
      for (const spec of [oldSpec, newSpec]) {
        expect(modelNames(spec)).toEqual(['ErrorBodyWithStatus404Or410']);
        expect(fieldType(spec, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus404Or410',
          values: [404, 410],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus404Or410']);
        expect(enumValues(spec, 'ErrorBodyStatus404Or410')).toEqual([404, 410]);
        expectEnumsSound(spec);
      }
      expect(changes(oldSpec, newSpec)).toEqual(['additive service-added Notes']);
      expect(await diffExitCode(oldDoc, newDoc)).toBe(1);
    },
  );

  it.each(VERSIONS)(
    'a `number` enum, an optional `status?` and a string enum under array items are named from the field and their values the same way, under OAS %s',
    async (version) => {
      const cases: Array<{
        body: Doc;
        model: string;
        field: string;
        type: TypeRef;
        enumName: string;
        values: (string | number)[];
      }> = [
        {
          body: obj({ message: str, ratio: { type: 'number', enum: [1.5, 2.5] } }),
          model: 'ErrorBodyWithRatio1Point5Or2Point5',
          field: 'ratio',
          type: { kind: 'enum', name: 'ErrorBodyRatio1Point5Or2Point5', values: [1.5, 2.5] },
          enumName: 'ErrorBodyRatio1Point5Or2Point5',
          values: [1.5, 2.5],
        },
        {
          body: obj({ message: str, status }, ['message']),
          model: 'ErrorBody',
          field: 'status',
          type: { kind: 'enum', name: 'ErrorBodyStatus404Or410', values: [404, 410] },
          enumName: 'ErrorBodyStatus404Or410',
          values: [404, 410],
        },
        {
          body: obj({ message: str, codes: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }),
          model: 'ErrorBodyWithCodesList',
          field: 'codes',
          type: { kind: 'array', items: { kind: 'enum', name: 'ErrorBodyCodesAOrB', values: ['a', 'b'] } },
          enumName: 'ErrorBodyCodesAOrB',
          values: ['a', 'b'],
        },
      ];
      for (const { body, model, field, type, enumName, values } of cases) {
        const oldDoc = doc(version, pets(nf(body)));
        const newDoc = doc(version, { ...pets(nf(body)), ...notes(nf(body)) });
        const oldSpec = await parseWithoutWarnings(oldDoc);
        const newSpec = await parseWithoutWarnings(newDoc);
        for (const spec of [oldSpec, newSpec]) {
          expect(modelNames(spec)).toEqual([model]);
          expect(fieldType(spec, model, field)).toEqual(type);
          expect(enumNames(spec)).toEqual([enumName]);
          expect(enumValues(spec, enumName)).toEqual(values);
          expectEnumsSound(spec);
        }
        expect(changes(oldSpec, newSpec)).toEqual(['additive service-added Notes']);
        expect(await diffExitCode(oldDoc, newDoc)).toBe(1);
      }
    },
  );

  it.each(VERSIONS)(
    'an enum through a nullable wrapper, under map values and on a nested body is named from its field and values too, under OAS %s',
    async (version) => {
      const nullableStatus =
        version === '3.0.3'
          ? { type: 'integer', enum: [404, 410, null], nullable: true }
          : { type: ['integer', 'null'], enum: [404, 410, null] };
      const bodies = {
        ...pets(nf(obj({ message: str, status: nullableStatus }))),
        ...notes(nf(obj({ message: str, status: nullableStatus }))),
        '/tags': {
          get: op(
            'listTags',
            nf(
              obj({
                message: str,
                levels: { type: 'object', additionalProperties: { type: 'integer', enum: [1, 2] } },
              }),
            ),
          ),
        },
        '/toys': {
          get: op('listToys', nf(obj({ message: str, detail: obj({ level: { type: 'integer', enum: [1, 2] } }) }))),
        },
      };
      const spec = await parseWithoutWarnings(doc(version, bodies));
      expect(fieldType(spec, 'ErrorBodyWithNullableStatus404Or410', 'status')).toEqual({
        kind: 'nullable',
        inner: { kind: 'enum', name: 'ErrorBodyStatus404Or410', values: [404, 410] },
      });
      expect(fieldType(spec, 'ErrorBodyWithLevels', 'levels')).toEqual({
        kind: 'map',
        valueType: { kind: 'enum', name: 'ErrorBodyLevels1Or2', values: [1, 2] },
      });
      expect(fieldType(spec, 'ErrorBodyWithLevel1Or2DetailDetail', 'level')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyLevel1Or2',
        values: [1, 2],
      });
      expect(enumNames(spec)).toEqual(['ErrorBodyLevel1Or2', 'ErrorBodyLevels1Or2', 'ErrorBodyStatus404Or410']);
      expectEnumsSound(spec);
    },
  );

  it.each(VERSIONS)(
    "the name depends on neither the operations' order nor their names, nor on how many status codes declare the body, under OAS %s",
    async (version) => {
      const petsFirst = await parseWithoutWarnings(doc(version, { ...pets(nf(statusBody)), ...notes(nf(statusBody)) }));
      const notesFirst = await parseWithoutWarnings(
        doc(version, { ...notes(nf(statusBody)), ...pets(nf(statusBody)) }),
      );
      // `aListPets` sorts before `listNotes`; `zListPets` after it.
      const renamedFirst = await parseWithoutWarnings(
        doc(version, { ...pets(nf(statusBody), 'aListPets'), ...notes(nf(statusBody)) }),
      );
      const renamedLast = await parseWithoutWarnings(
        doc(version, { ...pets(nf(statusBody), 'zListPets'), ...notes(nf(statusBody)) }),
      );
      // One operation declaring the body under two status codes.
      const twoCodes = await parseWithoutWarnings(
        doc(version, pets({ ...nf(statusBody), '410': { description: 'gone', content: json(statusBody) } })),
      );
      for (const spec of [petsFirst, notesFirst, renamedFirst, renamedLast, twoCodes]) {
        expect(modelNames(spec)).toEqual(['ErrorBodyWithStatus404Or410']);
        expect(fieldType(spec, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus404Or410',
          values: [404, 410],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus404Or410']);
        expectEnumsSound(spec);
      }
      expect(changes(petsFirst, notesFirst)).toEqual([]);
      // Renaming an operation moves the operation alone: no model, no enum.
      expect(changes(petsFirst, renamedFirst).filter((change) => !/ operation-/.test(change))).toEqual([]);
      expect(changes(petsFirst, renamedLast).filter((change) => !/ operation-/.test(change))).toEqual([]);
      for (const [a, b] of [
        [twoCodes, petsFirst],
        [petsFirst, twoCodes],
      ]) {
        expect(changes(a, b).filter((change) => / (enum|model)-/.test(change))).toEqual([]);
      }
    },
  );

  it.each(VERSIONS)(
    'a boolean `enum` is read as a string enum of the field already, and stays `ErrorBodyOk`, under OAS %s',
    async (version) => {
      const okBody = obj({ message: str, ok: { type: 'boolean', enum: [true, false] } });
      const spec = await parseWithoutWarnings(doc(version, { ...pets(nf(okBody)), ...notes(nf(okBody)) }));
      expect(fieldType(spec, 'ErrorBodyWithOk', 'ok')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyOk',
        values: ['false', 'true'],
      });
      expect(enumNames(spec)).toEqual(['ErrorBodyOk']);
      expectEnumsSound(spec);
    },
  );

  it.each(VERSIONS)(
    "the reviewer's documents: a second value set, a string-pinned `status` and an `errorCode` beside `error_code` each add an enum and rename none (exit 1), under OAS %s",
    async (version) => {
      const oldDoc = doc(version, pets(nf(statusBody)));
      const oldSpec = await parseWithoutWarnings(oldDoc);
      const was = { kind: 'enum', name: 'ErrorBodyStatus404Or410', values: [404, 410] };
      // A later body listing `status` to [500, 503], in either order of operations.
      const status500 = obj({ message: str, status: { type: 'integer', enum: [500, 503] } });
      const secondSet = doc(version, { ...pets(nf(statusBody)), ...notes(nf(status500)) });
      const secondSetSwapped = doc(version, { ...pets(nf(status500)), ...notes(nf(statusBody)) });
      const two = await parseWithoutWarnings(secondSet);
      const swapped = await parseWithoutWarnings(secondSetSwapped);
      for (const spec of [two, swapped]) {
        expect(modelNames(spec)).toEqual(['ErrorBodyWithStatus404Or410', 'ErrorBodyWithStatus500Or503']);
        expect(fieldType(spec, 'ErrorBodyWithStatus404Or410', 'status')).toEqual(was);
        expect(fieldType(spec, 'ErrorBodyWithStatus500Or503', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus500Or503',
          values: [500, 503],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus404Or410', 'ErrorBodyStatus500Or503']);
        expectEnumsSound(spec);
      }
      const added = [
        'additive model-added ErrorBodyWithStatus500Or503',
        'additive enum-added ErrorBodyStatus500Or503',
        'additive service-added Notes',
      ];
      expect(changes(oldSpec, two)).toEqual(added);
      // Swapped, `listPets` itself changes bodies; the models and enums move the same way.
      expect(changes(oldSpec, swapped).filter((change) => !/ operation-/.test(change))).toEqual(added);
      expect(await diffExitCode(oldDoc, secondSet)).toBe(1);
      // Two bodies pinning `status` to strings: the string rule's `ErrorBodyStatus` joins, the integer one stays.
      const pinnedDoc = doc(version, {
        ...pets(nf(statusBody)),
        ...notes(nf(obj({ message: str, status: { type: 'string', const: 'gone' } }))),
        '/tags': { get: op('listTags', nf(obj({ message: str, status: { type: 'string', const: 'lost' } }))) },
      });
      const pinned = await parseWithoutWarnings(pinnedDoc);
      expect(modelNames(pinned)).toEqual(['ErrorBodyWithStatus', 'ErrorBodyWithStatus404Or410']);
      expect(fieldType(pinned, 'ErrorBodyWithStatus404Or410', 'status')).toEqual(was);
      expect(fieldType(pinned, 'ErrorBodyWithStatus', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus',
        values: ['gone', 'lost'],
      });
      expect(enumNames(pinned)).toEqual(['ErrorBodyStatus', 'ErrorBodyStatus404Or410']);
      expectEnumsSound(pinned);
      expect(changes(oldSpec, pinned)).toEqual([
        'additive model-added ErrorBodyWithStatus',
        'additive enum-added ErrorBodyStatus',
        'additive service-added Notes',
        'additive service-added Tags',
      ]);
      expect(await diffExitCode(oldDoc, pinnedDoc)).toBe(1);
      // `errorCode` beside `error_code`: both spell `ErrorCode`, and each set keeps its own name.
      const errorCodeDoc = (extra: Doc): Doc =>
        doc(version, { ...pets(nf(obj({ message: str, error_code: { type: 'integer', enum: [1, 2] } }))), ...extra });
      const oldCodes = errorCodeDoc({});
      const newCodes = errorCodeDoc(notes(nf(obj({ message: str, errorCode: { type: 'integer', enum: [3, 4] } }))));
      const oldCodesSpec = await parseWithoutWarnings(oldCodes);
      const newCodesSpec = await parseWithoutWarnings(newCodes);
      const wasCode = { kind: 'enum', name: 'ErrorBodyErrorCode1Or2', values: [1, 2] };
      expect(fieldType(oldCodesSpec, 'ErrorBodyWithErrorCode1Or2', 'error_code')).toEqual(wasCode);
      expect(fieldType(newCodesSpec, 'ErrorBodyWithErrorCode1Or2', 'error_code')).toEqual(wasCode);
      expect(fieldType(newCodesSpec, 'ErrorBodyWithErrorCode3Or4', 'errorCode')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyErrorCode3Or4',
        values: [3, 4],
      });
      expect(enumNames(newCodesSpec)).toEqual(['ErrorBodyErrorCode1Or2', 'ErrorBodyErrorCode3Or4']);
      expectEnumsSound(newCodesSpec);
      expect(changes(oldCodesSpec, newCodesSpec)).toEqual([
        'additive model-added ErrorBodyWithErrorCode3Or4',
        'additive enum-added ErrorBodyErrorCode3Or4',
        'additive service-added Notes',
      ]);
      expect(await diffExitCode(oldCodes, newCodes)).toBe(1);
      // The same values under the two spellings share the one enum they spell.
      const sameCodes = errorCodeDoc(
        notes(nf(obj({ message: str, errorCode: { type: 'integer', enum: [1, 2] }, hint: str }))),
      );
      const sameCodesSpec = await parseWithoutWarnings(sameCodes);
      expect(modelNames(sameCodesSpec)).toEqual(['ErrorBodyWithErrorCode1Or2', 'ErrorBodyWithErrorCode1Or2Hint']);
      expect(fieldType(sameCodesSpec, 'ErrorBodyWithErrorCode1Or2', 'error_code')).toEqual(wasCode);
      expect(fieldType(sameCodesSpec, 'ErrorBodyWithErrorCode1Or2Hint', 'errorCode')).toEqual(wasCode);
      expect(enumNames(sameCodesSpec)).toEqual(['ErrorBodyErrorCode1Or2']);
      expectEnumsSound(sameCodesSpec);
      expect(changes(oldCodesSpec, sameCodesSpec)).toEqual([
        'additive model-added ErrorBodyWithErrorCode1Or2Hint',
        'additive service-added Notes',
      ]);
      expect(await diffExitCode(oldCodes, sameCodes)).toBe(1);
    },
  );

  it.each(VERSIONS)(
    'a `oneOf` of two inline enums under one field is two enums of it, and a field that ends in a digit spells its values behind `No`, under OAS %s',
    async (version) => {
      const unionBody = obj({
        message: str,
        status: {
          oneOf: [
            { type: 'integer', enum: [404, 410] },
            { type: 'string', enum: ['x', 'y'] },
          ],
        },
      });
      const v2 = (values: number[]): Doc => obj({ message: str, v2: { type: 'integer', enum: values } });
      const spelled = await parseWithoutWarnings(
        doc(version, {
          ...pets(nf(unionBody)),
          ...notes(nf(unionBody)),
          '/tags': { get: op('listTags', nf(v2([3, 4]))) },
          '/toys': { get: op('listToys', nf(v2([5, 6]))) },
        }),
      );
      expect(fieldType(spelled, 'ErrorBodyWithStatusOrStatus404Or410', 'status')).toEqual({
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [
          { kind: 'enum', name: 'ErrorBodyStatus404Or410', values: [404, 410] },
          { kind: 'enum', name: 'ErrorBodyStatusXOrY', values: ['x', 'y'] },
        ],
      });
      expect(fieldType(spelled, 'ErrorBodyWithV2No3Or4', 'v2')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyV2No3Or4',
        values: [3, 4],
      });
      expect(enumNames(spelled)).toEqual([
        'ErrorBodyStatus404Or410',
        'ErrorBodyStatusXOrY',
        'ErrorBodyV2No3Or4',
        'ErrorBodyV2No5Or6',
      ]);
      expectEnumsSound(spelled);
    },
  );

  it.each(VERSIONS)(
    "the string rule's enum keeps its name when an array under the same field lists the same values (#648 review), under OAS %s",
    async (version) => {
      // `status` pinned to strings in one body takes the string rule's
      // `ErrorBodyStatus`; an array of the same strings under `status` in
      // another spells its values — and the rename walk reads by field and
      // values, so it must leave the string rule's enum, which lists the
      // same values, under the name it claimed.
      const pinnedStatus = obj({ message: str, status: { type: 'string', enum: ['a', 'b'] } });
      const listedStatus = obj({
        message: str,
        status: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      });
      const oldDoc = doc(version, pets(nf(pinnedStatus)));
      const newDoc = doc(version, { ...pets(nf(pinnedStatus)), ...notes(nf(listedStatus)) });
      const oldSpec = await parseWithoutWarnings(oldDoc);
      const newSpec = await parseWithoutWarnings(newDoc);
      for (const spec of [oldSpec, newSpec]) {
        expect(fieldType(spec, 'ErrorBodyWithStatus', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus',
          values: ['a', 'b'],
        });
        expect(enumValues(spec, 'ErrorBodyStatus')).toEqual(['a', 'b']);
        expectEnumsSound(spec);
      }
      expect(fieldType(newSpec, 'ErrorBodyWithStatusList', 'status')).toEqual({
        kind: 'array',
        items: { kind: 'enum', name: 'ErrorBodyStatusAOrB', values: ['a', 'b'] },
      });
      expect(enumNames(newSpec)).toEqual(['ErrorBodyStatus', 'ErrorBodyStatusAOrB']);
      expect(changes(oldSpec, newSpec)).toEqual([
        'additive model-added ErrorBodyWithStatusList',
        'additive enum-added ErrorBodyStatusAOrB',
        'additive service-added Notes',
      ]);
      expect(await diffExitCode(oldDoc, newDoc)).toBe(1);
    },
  );

  it.each(VERSIONS)(
    'a name an enum of the same members holds is shared; one anything else holds leaves the bodies as they are, with a warning, under OAS %s',
    async (version) => {
      const bodies = { ...pets(nf(statusBody)), ...notes(nf(statusBody)) };
      // A component `ErrorBodyStatus404Or410` listing the same values, in any order, is the field's enum.
      const shared = await parseWithoutWarnings(
        doc(version, bodies, { ErrorBodyStatus404Or410: { type: 'integer', enum: [410, 404] } }),
      );
      expect(fieldType(shared, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus404Or410',
        values: [404, 410],
      });
      expect(enumNames(shared)).toEqual(['ErrorBodyStatus404Or410']);
      expect(enumValues(shared, 'ErrorBodyStatus404Or410')).toEqual([410, 404]);
      expectEnumsSound(shared);
      // A component `ErrorBodyStatus` of any members is no concern of the spelled name.
      const other = { type: 'string', enum: ['q', 'r'] };
      const bare = await parseWithoutWarnings(doc(version, bodies, { ErrorBodyStatus: other }));
      expect(fieldType(bare, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus404Or410',
        values: [404, 410],
      });
      expect(enumNames(bare)).toEqual(['ErrorBodyStatus', 'ErrorBodyStatus404Or410']);
      expect(enumValues(bare, 'ErrorBodyStatus')).toEqual(['q', 'r']);
      expectEnumsSound(bare);
      // The name taken by an enum of other members: the bodies that list the set stay as the parser materialized them, with a warning.
      const frozen = await parseWithWarnings(
        doc(version, bodies, { ErrorBodyStatus404Or410: { type: 'string', enum: ['z', 'w'] } }),
        [
          /The inline enum the shared error body \{ message: string, status: ListNotesError404Status \} lists for "status" would be named "ErrorBodyStatus404Or410", which enum "ErrorBodyStatus404Or410" already holds — keeping models "ListNotesError404", "ListPetsError404" as they are; rename one/,
        ],
      );
      expect(modelNames(frozen)).toEqual(['ListNotesError404', 'ListPetsError404']);
      expect(fieldType(frozen, 'ListPetsError404', 'status')).toEqual({
        kind: 'enum',
        name: 'ListPetsError404Status',
        values: [404, 410],
      });
      expect(enumNames(frozen)).toEqual([
        'ErrorBodyStatus404Or410',
        'ListNotesError404Status',
        'ListPetsError404Status',
      ]);
      // Two sets that spell one name with other members — `[1, 2]` beside
      // `['1', '2']`, both `1Or2` — the set that sorts first keeps it.
      const ambiguous = await parseWithWarnings(
        doc(version, {
          ...pets(nf(obj({ message: str, status: { type: 'integer', enum: [1, 2] } }))),
          ...notes(nf(obj({ message: str, status: { type: 'array', items: { type: 'string', enum: ['1', '2'] } } }))),
        }),
        [
          /The inline enum the shared error body \{ message: string, status: ListPetsError404Status \} lists for "status" would be named "ErrorBodyStatus1Or2", which the shared enum "ErrorBodyStatus1Or2" already holds — keeping model "ListPetsError404" as it is; rename one/,
        ],
      );
      expect(modelNames(ambiguous)).toEqual(['ErrorBodyWithStatusList', 'ListPetsError404']);
      expect(fieldType(ambiguous, 'ErrorBodyWithStatusList', 'status')).toEqual({
        kind: 'array',
        items: { kind: 'enum', name: 'ErrorBodyStatus1Or2', values: ['1', '2'] },
      });
      expect(fieldType(ambiguous, 'ListPetsError404', 'status')).toEqual({
        kind: 'enum',
        name: 'ListPetsError404Status',
        values: [1, 2],
      });
      expect(enumNames(ambiguous)).toEqual(['ErrorBodyStatus1Or2', 'ListPetsError404Status']);
    },
  );
});
