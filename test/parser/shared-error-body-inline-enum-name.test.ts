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
// the field, as a pinned string field's is (`ErrorBodyStatus`), one enum
// per field name and value set; when the shared bodies list a field of one
// name to two or more value sets, each set's enum spells its values
// (`ErrorBodyStatus404Or410` beside `ErrorBodyStatus500Or503`).

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
  diffSpecs(a, b).changes.map(({ classification, kind, name }) => `${classification} ${kind} ${name ?? ''}`.trim());

/** Every inline enum a model's field references is lifted once under that name with those values, and none keeps an operation's name. */
function expectEnumsSound(spec: ApiSpec): void {
  const lifted = new Map(spec.enums.map((e) => [e.name, e.values.map((v) => v.value)]));
  expect(new Set(lifted.keys()).size).toBe(spec.enums.length);
  for (const model of spec.models) {
    for (const field of model.fields) {
      walkTypeRef(field.type, {
        enum: (ref) => {
          expect(lifted.get(ref.name), `${model.name}.${field.name} → ${ref.name}`).toEqual(ref.values);
          expect(ref.name).not.toMatch(/^List(Pets|Notes)/);
        },
      });
    }
  }
}

describe('#612', () => {
  it.each(VERSIONS)(
    "the issue's repro: the shared body's `status` keeps one `ErrorBodyStatus` when `listNotes` is added, and the diff is additive (exit 1), under OAS %s",
    async (version) => {
      const oldDoc = doc(version, pets(nf(statusBody)));
      const newDoc = doc(version, { ...pets(nf(statusBody)), ...notes(nf(statusBody)) });
      const oldSpec = await parseWithoutWarnings(oldDoc);
      const newSpec = await parseWithoutWarnings(newDoc);
      for (const spec of [oldSpec, newSpec]) {
        expect(modelNames(spec)).toEqual(['ErrorBodyWithStatus404Or410']);
        expect(fieldType(spec, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus',
          values: [404, 410],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus']);
        expect(enumValues(spec, 'ErrorBodyStatus')).toEqual([404, 410]);
        expectEnumsSound(spec);
      }
      expect(changes(oldSpec, newSpec)).toEqual(['additive service-added Notes']);
      expect(await diffExitCode(oldDoc, newDoc)).toBe(1);
    },
  );

  it.each(VERSIONS)(
    'a `number` enum, an optional `status?` and a string enum under array items are named from the field the same way, under OAS %s',
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
          type: { kind: 'enum', name: 'ErrorBodyRatio', values: [1.5, 2.5] },
          enumName: 'ErrorBodyRatio',
          values: [1.5, 2.5],
        },
        {
          body: obj({ message: str, status }, ['message']),
          model: 'ErrorBody',
          field: 'status',
          type: { kind: 'enum', name: 'ErrorBodyStatus', values: [404, 410] },
          enumName: 'ErrorBodyStatus',
          values: [404, 410],
        },
        {
          body: obj({ message: str, codes: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }),
          model: 'ErrorBodyWithCodesList',
          field: 'codes',
          type: { kind: 'array', items: { kind: 'enum', name: 'ErrorBodyCodes', values: ['a', 'b'] } },
          enumName: 'ErrorBodyCodes',
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
    'an enum through a nullable wrapper, under map values and on a nested body is named from its field too, under OAS %s',
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
        inner: { kind: 'enum', name: 'ErrorBodyStatus', values: [404, 410] },
      });
      expect(fieldType(spec, 'ErrorBodyWithLevels', 'levels')).toEqual({
        kind: 'map',
        valueType: { kind: 'enum', name: 'ErrorBodyLevels', values: [1, 2] },
      });
      expect(fieldType(spec, 'ErrorBodyWithLevel1Or2DetailDetail', 'level')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyLevel',
        values: [1, 2],
      });
      expect(enumNames(spec)).toEqual(['ErrorBodyLevel', 'ErrorBodyLevels', 'ErrorBodyStatus']);
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
          name: 'ErrorBodyStatus',
          values: [404, 410],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus']);
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
    'two value sets under one field name: each enum spells its values, a function of the sets alone, and a second set renames the first, under OAS %s',
    async (version) => {
      const status500 = { type: 'integer', enum: [500, 503] };
      const oneSet = doc(version, pets(nf(statusBody)));
      const twoSets = doc(version, { ...pets(nf(statusBody)), ...notes(nf(obj({ message: str, status: status500 }))) });
      const twoSetsSwapped = doc(version, {
        ...pets(nf(obj({ message: str, status: status500 }))),
        ...notes(nf(statusBody)),
      });
      const one = await parseWithoutWarnings(oneSet);
      const two = await parseWithoutWarnings(twoSets);
      const swapped = await parseWithoutWarnings(twoSetsSwapped);
      for (const spec of [two, swapped]) {
        expect(modelNames(spec)).toEqual(['ErrorBodyWithStatus404Or410', 'ErrorBodyWithStatus500Or503']);
        expect(fieldType(spec, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus404Or410',
          values: [404, 410],
        });
        expect(fieldType(spec, 'ErrorBodyWithStatus500Or503', 'status')).toEqual({
          kind: 'enum',
          name: 'ErrorBodyStatus500Or503',
          values: [500, 503],
        });
        expect(enumNames(spec)).toEqual(['ErrorBodyStatus404Or410', 'ErrorBodyStatus500Or503']);
        expectEnumsSound(spec);
      }
      // The stated consequence: the lone set's enum takes its spelled name.
      const renamed = [
        'additive model-added ErrorBodyWithStatus500Or503',
        'breaking model-modified ErrorBodyWithStatus404Or410',
        'additive enum-added ErrorBodyStatus404Or410',
        'additive enum-added ErrorBodyStatus500Or503',
        'breaking enum-removed ErrorBodyStatus',
        'additive service-added Notes',
      ];
      expect(changes(one, two)).toEqual(renamed);
      // Swapped, `listPets` itself changes bodies; the models and enums move the same way.
      expect(changes(one, swapped).filter((change) => !/ operation-/.test(change))).toEqual(renamed);
      expect(await diffExitCode(oneSet, twoSets)).toBe(2);
      // A union of two inline enums under one field is two sets of it; a
      // field that ends in a digit spells its values behind `No`.
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
    'a name an enum of the same members holds is shared; one anything else holds sends the set to its spelled name; a spelled name taken leaves the bodies as they are, under OAS %s',
    async (version) => {
      const bodies = { ...pets(nf(statusBody)), ...notes(nf(statusBody)) };
      // A component `ErrorBodyStatus` listing the same values is the field's enum.
      const shared = await parseWithoutWarnings(doc(version, bodies, { ErrorBodyStatus: status }));
      expect(fieldType(shared, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus',
        values: [404, 410],
      });
      expect(enumNames(shared)).toEqual(['ErrorBodyStatus']);
      expect(enumValues(shared, 'ErrorBodyStatus')).toEqual([404, 410]);
      expectEnumsSound(shared);
      // One of other members sends the set to its spelled name, silently: the name is a function of the shape.
      const other = { type: 'string', enum: ['q', 'r'] };
      const spelled = await parseWithoutWarnings(doc(version, bodies, { ErrorBodyStatus: other }));
      expect(fieldType(spelled, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus404Or410',
        values: [404, 410],
      });
      expect(enumNames(spelled)).toEqual(['ErrorBodyStatus', 'ErrorBodyStatus404Or410']);
      expect(enumValues(spelled, 'ErrorBodyStatus')).toEqual(['q', 'r']);
      expectEnumsSound(spelled);
      // The string rule holding the bare name — another body pins `status` to strings — does the same.
      const pinned = await parseWithoutWarnings(
        doc(version, { ...pets(nf(statusBody)), ...notes(nf(obj({ message: str, status: other }))) }),
      );
      expect(modelNames(pinned)).toEqual(['ErrorBodyWithStatus', 'ErrorBodyWithStatus404Or410']);
      expect(fieldType(pinned, 'ErrorBodyWithStatus', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus',
        values: ['q', 'r'],
      });
      expect(fieldType(pinned, 'ErrorBodyWithStatus404Or410', 'status')).toEqual({
        kind: 'enum',
        name: 'ErrorBodyStatus404Or410',
        values: [404, 410],
      });
      expect(enumNames(pinned)).toEqual(['ErrorBodyStatus', 'ErrorBodyStatus404Or410']);
      expectEnumsSound(pinned);
      // The spelled name taken too: the bodies that list the set stay as the parser materialized them, with a warning.
      const frozen = await parseWithWarnings(
        doc(version, bodies, { ErrorBodyStatus: other, ErrorBodyStatus404Or410: { type: 'string', enum: ['z', 'w'] } }),
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
        'ErrorBodyStatus',
        'ErrorBodyStatus404Or410',
        'ListNotesError404Status',
        'ListPetsError404Status',
      ]);
    },
  );
});
