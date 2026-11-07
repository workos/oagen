import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #603: a request body written as a `oneOf` of string consts was
 * built as a union of literals — `typePickedRequestBody` built every
 * `oneOf` that is not a nullable wrapper variant by variant, before
 * `schemaToTypeRef`, which reads such a union as an enum, was reached — so
 * the body had no enum and each value's `description` was lost, while the
 * same schema written with `anyOf`, or as a webhook payload or a field, was
 * the enum, and switching `anyOf` to `oneOf` in a body read as breaking.
 * A `oneOf` `inlineEnumSpelling` reads as a const union now takes the
 * fall-through, where it is typed as `anyOf` is: the enum `<Op>Request`.
 */

type Keyword = 'oneOf' | 'anyOf';

/** A string const variant in the document's spelling: OAS 3.1 `const`, OAS 3.0 a single-value `enum`. */
const constOf = (openapi: string, value: string, description?: string) => ({
  type: 'string',
  ...(openapi.startsWith('3.0') ? { enum: [value] } : { const: value }),
  ...(description !== undefined ? { description } : {}),
});

/** A `null` variant in the document's spelling: OAS 3.1 `type: 'null'`, OAS 3.0 `enum: [null]`. */
const nullOf = (openapi: string) => (openapi.startsWith('3.0') ? { enum: [null] } : { type: 'null' });

/** The issue's two consts: `draft` ("A draft.") and `final` ("A final note."). */
const draftAndFinal = (openapi: string) => [
  constOf(openapi, 'draft', 'A draft.'),
  constOf(openapi, 'final', 'A final note.'),
];

const DRAFT = { name: 'DRAFT', value: 'draft', description: 'A draft.' };
const FINAL = { name: 'FINAL', value: 'final', description: 'A final note.' };

/**
 * The issue's repro: `POST /notes` (`addNote`) and the webhook `noteAdded`,
 * both with a body of `keyword` over `variants` (`extra` beside it) — plus,
 * past the issue, a callback `noteSaved` on the operation posting the same
 * body, a secondary `text/plain` media type carrying it, and a component
 * `Note` whose `status` field is the same schema, so every site that types
 * the schema can be compared. `schemas` adds components beside `Note`.
 */
function repro(
  openapi: string,
  keyword: Keyword,
  variants: unknown[],
  extra: Record<string, unknown> = {},
  schemas: Record<string, unknown> = {},
) {
  const schema = { ...extra, [keyword]: variants };
  const body = { required: true, content: { 'application/json': { schema } } };
  return {
    openapi,
    info: { title: 'Notes', version: '1.0.0' },
    paths: {
      '/notes': {
        post: {
          operationId: 'addNote',
          requestBody: {
            required: true,
            content: { 'application/json': { schema }, 'text/plain': { schema } },
          },
          responses: { '204': { description: 'Added.' } },
          callbacks: {
            noteSaved: {
              '{$request.body#/url}': { post: { requestBody: body, responses: { '204': { description: 'ok' } } } },
            },
          },
        },
      },
    },
    webhooks: { noteAdded: { post: { requestBody: body, responses: { '204': { description: 'ok' } } } } },
    components: { schemas: { Note: { type: 'object', properties: { status: schema } }, ...schemas } },
  };
}

const enumOf = (name: string, values: string[]): TypeRef => ({ kind: 'enum', name, values });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

describe('#603', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-603-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    log.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeDocument(name: string, doc: unknown): Promise<string> {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  async function parseDocument(name: string, doc: unknown): Promise<ApiSpec> {
    return parseSpec(await writeDocument(name, doc));
  }

  const addNote = (spec: ApiSpec): Operation =>
    spec.services.flatMap((service) => service.operations).find((op) => op.name === 'addNote')!;

  /** Every site the repro types the schema at, with the enums and models minted. */
  function sites(spec: ApiSpec) {
    const op = addNote(spec);
    return {
      body: op.requestBody,
      secondary: op.requestBodyContents?.find((content) => content.contentType === 'text/plain')?.type,
      callback: op.callbacks?.[0]?.requestBody,
      webhook: spec.webhooks?.[0]?.requestBody,
      field: spec.models.find((model) => model.name === 'Note')?.fields.find((field) => field.name === 'status')?.type,
      enums: spec.enums,
      models: spec.models.map((model) => model.name),
    };
  }

  /** The exit code `oagen diff --old from --new to` ends with. */
  async function exitCodeOf(from: string, to: string): Promise<number> {
    const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  }

  for (const openapi of ['3.1.0', '3.0.3']) {
    describe(`OAS ${openapi}`, () => {
      it('types the oneOf body as the enum AddNoteRequest, each member documented, exactly as anyOf and the webhook payload are', async () => {
        const oneOf = await parseDocument('one-of.json', repro(openapi, 'oneOf', draftAndFinal(openapi)));
        const anyOf = await parseDocument('any-of.json', repro(openapi, 'anyOf', draftAndFinal(openapi)));

        // The issue's Expected: the body is the enum, not a union of two literals.
        expect(addNote(oneOf).requestBody).toEqual(enumOf('AddNoteRequest', ['draft', 'final']));
        expect(oneOf.webhooks?.[0]?.requestBody).toEqual(enumOf('NoteAddedPayload', ['draft', 'final']));
        expect(oneOf.enums.find((e) => e.name === 'AddNoteRequest')?.values).toEqual([DRAFT, FINAL]);
        expect(oneOf.enums.map((e) => e.name)).toEqual([
          'NoteStatus',
          'AddNoteRequest',
          'AddNoteTextPlainRequest',
          'NoteAddedPayload',
          'AddNoteNoteSavedPayload',
        ]);
        expect(warn).not.toHaveBeenCalled();

        // Every site agrees with the same schema written as `anyOf`: the
        // primary and the secondary media type, the callback payload, the
        // webhook payload and the field, and the enums minted for them.
        expect(sites(oneOf)).toEqual(sites(anyOf));
        expect(sites(oneOf)).toMatchObject({
          body: enumOf('AddNoteRequest', ['draft', 'final']),
          secondary: enumOf('AddNoteTextPlainRequest', ['draft', 'final']),
          callback: enumOf('AddNoteNoteSavedPayload', ['draft', 'final']),
          webhook: enumOf('NoteAddedPayload', ['draft', 'final']),
          field: enumOf('NoteStatus', ['draft', 'final']),
          models: ['Note'],
        });
      });

      it('keeps the members in document order, whichever order the variants are written in', async () => {
        const reversed = [...draftAndFinal(openapi)].reverse();
        const oneOf = await parseDocument('one-of.json', repro(openapi, 'oneOf', reversed));
        const anyOf = await parseDocument('any-of.json', repro(openapi, 'anyOf', reversed));
        expect(addNote(oneOf).requestBody).toEqual(enumOf('AddNoteRequest', ['final', 'draft']));
        expect(oneOf.enums.find((e) => e.name === 'AddNoteRequest')?.values).toEqual([FINAL, DRAFT]);
        expect(sites(oneOf)).toEqual(sites(anyOf));
      });

      it('reports no change between the two spellings, and oagen diff exits 0', async () => {
        const oneOfFile = await writeDocument('one-of.json', repro(openapi, 'oneOf', draftAndFinal(openapi)));
        const anyOfFile = await writeDocument('any-of.json', repro(openapi, 'anyOf', draftAndFinal(openapi)));
        const [oneOf, anyOf] = await Promise.all([parseSpec(oneOfFile), parseSpec(anyOfFile)]);
        // Before: a breaking `enum-removed` (`AddNoteRequest`) and a breaking
        // `operation-modified` (`requestBodyChanged`), exit code 2.
        expect(diffSpecs(anyOf, oneOf).changes).toEqual([]);
        expect(diffSpecs(oneOf, anyOf).changes).toEqual([]);
        expect(await exitCodeOf(anyOfFile, oneOfFile)).toBe(0);
        expect(await exitCodeOf(oneOfFile, anyOfFile)).toBe(0);
      });

      it('makes a null variant beside the consts, or a nullable wrapper beside the union, nullable<AddNoteRequest>', async () => {
        const withNullVariant = [...draftAndFinal(openapi), nullOf(openapi)];
        const wrapper = openapi.startsWith('3.0') ? { type: 'string', nullable: true } : { type: ['string', 'null'] };
        for (const [name, variants, extra] of [
          ['null-variant', withNullVariant, {}],
          ['nullable-wrapper', draftAndFinal(openapi), wrapper],
          // Both at once is still one nullable enum.
          ['both', withNullVariant, wrapper],
        ] as const) {
          const oneOf = await parseDocument(`${name}-one-of.json`, repro(openapi, 'oneOf', variants, extra));
          const anyOf = await parseDocument(`${name}-any-of.json`, repro(openapi, 'anyOf', variants, extra));
          expect(addNote(oneOf).requestBody, name).toEqual(nullable(enumOf('AddNoteRequest', ['draft', 'final'])));
          expect(oneOf.enums.find((e) => e.name === 'AddNoteRequest')?.values, name).toEqual([DRAFT, FINAL]);
          expect(sites(oneOf), name).toEqual(sites(anyOf));
          expect(sites(oneOf), name).toMatchObject({
            webhook: nullable(enumOf('NoteAddedPayload', ['draft', 'final'])),
            field: nullable(enumOf('NoteStatus', ['draft', 'final'])),
          });
        }
      });

      it('reads an enum list beside the union as the field does: the members it allows, null only when it admits null', async () => {
        const variants = [...draftAndFinal(openapi), nullOf(openapi)];
        const oneOf = await parseDocument('one-of.json', repro(openapi, 'oneOf', variants, { enum: ['draft'] }));
        const anyOf = await parseDocument('any-of.json', repro(openapi, 'anyOf', variants, { enum: ['draft'] }));
        expect(addNote(oneOf).requestBody).toEqual(enumOf('AddNoteRequest', ['draft']));
        expect(oneOf.enums.find((e) => e.name === 'AddNoteRequest')?.values).toEqual([DRAFT]);
        expect(sites(oneOf)).toEqual(sites(anyOf));
      });

      it('keeps a oneOf that mixes consts with any other variant a union, and a lone const beside null a nullable literal', async () => {
        const draft = constOf(openapi, 'draft', 'A draft.');
        const literal = (value: string | number): TypeRef => ({ kind: 'literal', value });
        for (const [name, variants, expected] of [
          [
            'string',
            [draft, { type: 'string', description: 'Anything else.' }],
            [literal('draft'), { kind: 'primitive', type: 'string' }],
          ],
          [
            'ref',
            [...draftAndFinal(openapi), { $ref: '#/components/schemas/Note' }],
            [literal('draft'), literal('final'), { kind: 'model', name: 'Note' }],
          ],
          ['number', [{ const: 1 }, { const: 2 }], [literal(1), literal(2)]],
        ] as const) {
          const spec = await parseDocument(`${name}.json`, repro(openapi, 'oneOf', [...variants]));
          const op = addNote(spec);
          // No enum is minted: the body is the union of the variants as written.
          expect(op.requestBody, name).toEqual({ kind: 'union', variants: [...expected] });
          expect(spec.enums, name).toEqual([]);
          // The field, the webhook and the callback are the same union, each
          // carrying the keyword as every union `schemaToTypeRef` builds does.
          expect(sites(spec), name).toMatchObject({
            field: { kind: 'union', variants: [...expected], compositionKind: 'oneOf' },
            webhook: { kind: 'union', variants: [...expected], compositionKind: 'oneOf' },
            callback: { kind: 'union', variants: [...expected], compositionKind: 'oneOf' },
          });
        }

        // One const beside `null`, with no `enum:` list: no enum, the nullable literal it was.
        const lone = await parseDocument('lone.json', repro(openapi, 'oneOf', [draft, nullOf(openapi)]));
        expect(addNote(lone).requestBody).toEqual(nullable(literal('draft')));
        expect(lone.enums).toEqual([]);
        expect(sites(lone)).toMatchObject({ field: nullable(literal('draft')), webhook: nullable(literal('draft')) });
      });

      it('mints the name anyOf mints beside a component enum or model called AddNoteRequest', async () => {
        for (const [name, component, expected] of [
          // Other members under the name: the body's enum is numbered past it.
          ['enum', { type: 'string', enum: ['x', 'y'] }, 'AddNoteRequest2'],
          // The same members: the component is shared.
          ['same', { type: 'string', enum: ['draft', 'final'] }, 'AddNoteRequest'],
          // A model's name is never an enum's.
          ['model', { type: 'object', properties: { id: { type: 'string' } } }, 'AddNoteRequest2'],
        ] as const) {
          const schemas = { AddNoteRequest: component };
          const oneOf = await parseDocument(
            `${name}-one-of.json`,
            repro(openapi, 'oneOf', draftAndFinal(openapi), {}, schemas),
          );
          const anyOf = await parseDocument(
            `${name}-any-of.json`,
            repro(openapi, 'anyOf', draftAndFinal(openapi), {}, schemas),
          );
          expect(addNote(oneOf).requestBody, name).toEqual(enumOf(expected, ['draft', 'final']));
          expect(sites(oneOf), name).toEqual(sites(anyOf));
        }
      });
    });
  }
});
