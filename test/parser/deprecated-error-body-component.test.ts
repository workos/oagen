import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #629: the error-body fold gave a deprecated `ErrorBody` component
 * every live `{ message }` body of its shape, so a live operation's error
 * was typed as a deprecated model, and a component whose `message` was
 * deprecated took bodies whose `message` was live, so their field read as
 * deprecated. `componentAccepts` read neither the component's `deprecated`
 * nor its fields'. Now the fold reads the flags as every other inline-model
 * comparison does: a deprecated component takes no body (#441), a field's
 * `deprecated` is shape — in the key, in the name
 * (`ErrorBodyWithDeprecatedMessage`) and in what a component must match —
 * and a body's own flag is read apart from its shape, the shared model
 * deprecated only when every body is, a deprecated body folding onto a live
 * model with a warning.
 */

type Doc = Record<string, unknown>;
const str = { type: 'string' };
const obj = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
  extra: Doc = {},
): Doc => ({
  type: 'object',
  properties,
  required,
  ...extra,
});
const json = (schema: Doc) => ({ 'application/json': { schema } });
/** `{ message: string }`, `message` required: the issue's inline error body, and the `ErrorBody` component's shape. */
const messageBody = (extra: Doc = {}): Doc => obj({ message: str }, ['message'], extra);
/** The same body, its `message` deprecated. */
const deprecatedMessageBody = (): Doc => obj({ message: { ...str, deprecated: true } }, ['message']);
/** `{ message, hint? }`, `hint` deprecated or live. */
const hintedBody = (deprecatedHint: boolean): Doc =>
  obj({ message: str, hint: deprecatedHint ? { ...str, deprecated: true } : str }, ['message']);

/** `GET /<name>s` (`get<Name>`) returning `{ name? }` on `200` and `body` on `404` — the issue's operations. */
function getOp(name: string, body: Doc = messageBody()): Doc {
  return {
    [`/${name}s`]: {
      get: {
        operationId: `get${name[0].toUpperCase()}${name.slice(1)}`,
        responses: {
          '200': { description: 'ok', content: json({ type: 'object', properties: { name: str } }) },
          '404': { description: 'nf', content: json(body) },
        },
      },
    },
  };
}

function doc(paths: Doc, schemas: Doc = {}, openapi = '3.1.0'): Doc {
  return { openapi, info: { title: '629', version: '1' }, paths, components: { schemas } };
}

async function parse(spec: Doc): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-629-'));
  const file = path.join(dir, 'spec.json');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    const parsed = await parseSpec(file);
    return { spec: parsed, warnings: warn.mock.calls.map(([message]) => String(message)) };
  } finally {
    warn.mockRestore();
    await fs.rm(dir, { recursive: true });
  }
}

const refName = (type: TypeRef | undefined): string | undefined => (type?.kind === 'model' ? type.name : undefined);
/** `getPet 404: ErrorBody` per operation, in document order — what the issue's script prints. */
const errorTypes = (spec: ApiSpec): string[] =>
  spec.services
    .flatMap((service) => service.operations)
    .map((op) => `${op.name} ${op.errors[0].statusCode}: ${refName(op.errors[0].type)}`);
/** `ErrorBody (deprecated) { message }` per model, in list order — what the issue's script prints. */
const modelShapes = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ deprecated, fields, name }) =>
      `${name}${deprecated ? ' (deprecated)' : ''} { ${fields
        .map((field) => `${field.name}${field.deprecated ? ' (deprecated)' : ''}`)
        .join(', ')} }`,
  );
/** The exit code `oagen diff` gives a diff (`src/cli/diff.ts`): 2 on a breaking change, 1 on any other change, 0 on none. */
const exitCodeOf = ({ summary }: ReturnType<typeof diffSpecs>): number =>
  summary.breaking > 0 ? 2 : summary.modified > 0 || summary.removed > 0 || summary.added > 0 ? 1 : 0;
/** Every change `oagen diff` reports, as `kind name [flags]: classification`, its field changes indented beneath, with the exit code. */
function describeDiff(oldSpec: ApiSpec, newSpec: ApiSpec): { changes: string[]; exitCode: number } {
  const diff = diffSpecs(oldSpec, newSpec);
  return {
    exitCode: exitCodeOf(diff),
    changes: diff.changes.flatMap((change) => {
      const rest = change as unknown as Record<string, unknown>;
      const fieldChanges =
        (rest.fieldChanges as Array<{ kind: string; fieldName: string; classification: string }> | undefined) ?? [];
      const flags = Object.keys(rest)
        .filter((k) => k.endsWith('Changed') && rest[k] === true)
        .map((k) => ` ${k}`)
        .join('');
      const label = 'name' in change ? change.name : 'operationName' in change ? change.operationName : undefined;
      return [
        `${change.kind} ${label}${flags}: ${change.classification}`,
        ...fieldChanges.map((f) => `  ${f.kind} ${f.fieldName}: ${f.classification}`),
      ];
    }),
  };
}

const leftAsTheyAre = (holder: string, shape = '{ message: string }') =>
  `[oagen] Warning: The shared error body ${shape} would be named "ErrorBody", which ${holder} already holds — keeping models "GetNoteError404", "GetPetError404" as they are; give the two the same shape, or rename one`;

describe('#629', () => {
  type Order = 'pets-first' | 'notes-first';
  const ops = (order: Order): Doc =>
    order === 'pets-first' ? { ...getOp('pet'), ...getOp('note') } : { ...getOp('note'), ...getOp('pet') };
  /** The issue's `repro.json`: `getPet` and `getNote`, each with an inline `{ message }` 404, beside a deprecated `ErrorBody` component of that shape. */
  const repro = (openapi: string, order: Order = 'pets-first'): Doc =>
    doc(ops(order), { ErrorBody: messageBody({ deprecated: true }) }, openapi);
  /** The issue's `field.json`: the same, `ErrorBody` live with its `message` deprecated. */
  const field = (openapi: string, order: Order = 'pets-first'): Doc =>
    doc(ops(order), { ErrorBody: deprecatedMessageBody() }, openapi);
  /** The issue's `old.json`: the same, `ErrorBody` live. */
  const old = (openapi: string): Doc => doc(ops('pets-first'), { ErrorBody: messageBody() }, openapi);

  describe.each(['3.0.3', '3.1.0'] as const)('under OAS %s', (openapi) => {
    it('a deprecated `ErrorBody` component takes no live body: each keeps a live model of its own, as beside a component of another shape', async () => {
      const { spec, warnings } = await parse(repro(openapi));
      expect(errorTypes(spec)).toEqual(['getPet 404: GetPetError404', 'getNote 404: GetNoteError404']);
      expect(modelShapes(spec)).toEqual([
        'ErrorBody (deprecated) { message }',
        'GetPetResponse { name }',
        'GetNoteResponse { name }',
        'GetPetError404 { message }',
        'GetNoteError404 { message }',
      ]);
      expect(warnings).toEqual([leftAsTheyAre('deprecated component schema "ErrorBody"')]);
    });

    it('a component whose `message` is deprecated takes no body whose `message` is live, as it takes no body of another shape', async () => {
      const { spec, warnings } = await parse(field(openapi));
      expect(errorTypes(spec)).toEqual(['getPet 404: GetPetError404', 'getNote 404: GetNoteError404']);
      expect(modelShapes(spec)).toEqual([
        'ErrorBody { message (deprecated) }',
        'GetPetResponse { name }',
        'GetNoteResponse { name }',
        'GetPetError404 { message }',
        'GetNoteError404 { message }',
      ]);
      expect(warnings).toEqual([leftAsTheyAre('component schema "ErrorBody"')]);
    });

    it('a live `ErrorBody` of the shape still takes both bodies (`old.json`)', async () => {
      const { spec, warnings } = await parse(old(openapi));
      expect(errorTypes(spec)).toEqual(['getPet 404: ErrorBody', 'getNote 404: ErrorBody']);
      expect(modelShapes(spec)).toEqual([
        'ErrorBody { message }',
        'GetPetResponse { name }',
        'GetNoteResponse { name }',
      ]);
      expect(warnings).toEqual([]);
    });

    it('a single operation keeps its live model the same way', async () => {
      for (const component of [messageBody({ deprecated: true }), deprecatedMessageBody()]) {
        const { spec, warnings } = await parse(doc(getOp('pet'), { ErrorBody: component }, openapi));
        expect(errorTypes(spec)).toEqual(['getPet 404: GetPetError404']);
        expect(spec.models.find((m) => m.name === 'GetPetError404')).toEqual({
          name: 'GetPetError404',
          fields: [{ name: 'message', type: { kind: 'primitive', type: 'string' }, required: true }],
        });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/keeping model "GetPetError404" as it is/);
      }
    });

    it('decides the same whichever operation comes first', async () => {
      for (const make of [repro, field]) {
        const petsFirst = await parse(make(openapi, 'pets-first'));
        const notesFirst = await parse(make(openapi, 'notes-first'));
        expect([...errorTypes(notesFirst.spec)].sort()).toEqual([...errorTypes(petsFirst.spec)].sort());
        expect([...modelShapes(notesFirst.spec)].sort()).toEqual([...modelShapes(petsFirst.spec)].sort());
        expect(notesFirst.warnings).toEqual(petsFirst.warnings);
      }
    });

    it('`oagen diff` from `old.json` reports the models the live bodies now get, the `ErrorBody` flip and each operation’s retyped error, exit 2', async () => {
      const before = (await parse(old(openapi))).spec;
      expect(describeDiff(before, (await parse(repro(openapi))).spec)).toEqual({
        exitCode: 2,
        changes: [
          'model-added GetPetError404: additive',
          'model-added GetNoteError404: additive',
          'model-modified ErrorBody deprecatedChanged: additive',
          'operation-modified getPet errorsChanged: breaking',
          'operation-modified getNote errorsChanged: breaking',
        ],
      });
      expect(describeDiff(before, (await parse(field(openapi))).spec)).toEqual({
        exitCode: 2,
        changes: [
          'model-added GetPetError404: additive',
          'model-added GetNoteError404: additive',
          'model-modified ErrorBody: additive',
          '  field-deprecated-changed message: additive',
          'operation-modified getPet errorsChanged: breaking',
          'operation-modified getNote errorsChanged: breaking',
        ],
      });
    });
  });

  describe('a field’s `deprecated` is shape, as it is wherever an inline model is compared', () => {
    it('a body whose `message` is deprecated and one whose `message` is live are two models, `ErrorBodyWithDeprecatedMessage` beside `ErrorBody`, in either order', async () => {
      for (const paths of [
        { ...getOp('pet', deprecatedMessageBody()), ...getOp('note') },
        { ...getOp('note'), ...getOp('pet', deprecatedMessageBody()) },
      ]) {
        const { spec, warnings } = await parse(doc(paths));
        expect(warnings).toEqual([]);
        expect([...errorTypes(spec)].sort()).toEqual([
          'getNote 404: ErrorBody',
          'getPet 404: ErrorBodyWithDeprecatedMessage',
        ]);
        expect(modelShapes(spec).filter((shape) => shape.startsWith('ErrorBody'))).toEqual([
          'ErrorBody { message }',
          'ErrorBodyWithDeprecatedMessage { message (deprecated) }',
        ]);
      }
    });

    it('two bodies that deprecate `message` share `ErrorBodyWithDeprecatedMessage`, which a live component of that name and shape takes', async () => {
      const paths = { ...getOp('pet', deprecatedMessageBody()), ...getOp('note', deprecatedMessageBody()) };
      const shared = await parse(doc(paths));
      expect(shared.warnings).toEqual([]);
      expect(errorTypes(shared.spec)).toEqual([
        'getPet 404: ErrorBodyWithDeprecatedMessage',
        'getNote 404: ErrorBodyWithDeprecatedMessage',
      ]);
      expect(modelShapes(shared.spec)).toContain('ErrorBodyWithDeprecatedMessage { message (deprecated) }');
      const component = await parse(doc(paths, { ErrorBodyWithDeprecatedMessage: deprecatedMessageBody() }));
      expect(component.warnings).toEqual([]);
      expect(errorTypes(component.spec)).toEqual([
        'getPet 404: ErrorBodyWithDeprecatedMessage',
        'getNote 404: ErrorBodyWithDeprecatedMessage',
      ]);
      expect(modelShapes(component.spec)).toEqual([
        'ErrorBodyWithDeprecatedMessage { message (deprecated) }',
        'GetPetResponse { name }',
        'GetNoteResponse { name }',
      ]);
    });

    it('a component takes a body only when it flags each optional field as the body does, in either direction', async () => {
      const liveHint = await parse(
        doc({ ...getOp('pet', hintedBody(true)), ...getOp('note') }, { ErrorBody: hintedBody(false) }),
      );
      expect(errorTypes(liveHint.spec)).toEqual(['getPet 404: GetPetError404', 'getNote 404: ErrorBody']);
      expect(liveHint.warnings).toEqual([
        '[oagen] Warning: The shared error body { message: string, hint? (deprecated): string } would be named "ErrorBody", which component schema "ErrorBody" already holds — keeping model "GetPetError404" as it is; give the two the same shape, or rename one',
      ]);
      const deprecatedHint = await parse(
        doc({ ...getOp('pet', hintedBody(false)), ...getOp('note') }, { ErrorBody: hintedBody(true) }),
      );
      expect(errorTypes(deprecatedHint.spec)).toEqual(['getPet 404: GetPetError404', 'getNote 404: ErrorBody']);
      expect(deprecatedHint.warnings).toEqual([
        '[oagen] Warning: The shared error body { message: string, hint?: string } would be named "ErrorBody", which component schema "ErrorBody" already holds — keeping model "GetPetError404" as it is; give the two the same shape, or rename one',
      ]);
    });

    it('an optional field’s flag is not shape: it is kept when every body that carries the field agrees, and dropped with a warning when they do not', async () => {
      const carried = await parse(doc({ ...getOp('pet', hintedBody(true)), ...getOp('note') }));
      expect(carried.warnings).toEqual([]);
      expect(errorTypes(carried.spec)).toEqual(['getPet 404: ErrorBody', 'getNote 404: ErrorBody']);
      expect(modelShapes(carried.spec)).toContain('ErrorBody { message, hint (deprecated) }');
      const disagreeing = await parse(doc({ ...getOp('pet', hintedBody(true)), ...getOp('note', hintedBody(false)) }));
      expect(errorTypes(disagreeing.spec)).toEqual(['getPet 404: ErrorBody', 'getNote 404: ErrorBody']);
      expect(modelShapes(disagreeing.spec)).toContain('ErrorBody { message, hint }');
      expect(disagreeing.warnings).toEqual([
        '[oagen] Warning: The shared error body "ErrorBody" keeps "hint" live: its bodies flag it apart ("GetNoteError404" live, "GetPetError404" deprecated); deprecate it on every body, or on none',
      ]);
    });
  });

  describe('a body’s own `deprecated` is read apart from its shape, as a copy’s is wherever an inline model is compared (#441)', () => {
    it('a deprecated body beside live ones folds onto the live model, with a warning naming the bodies', async () => {
      const { spec, warnings } = await parse(
        doc({ ...getOp('pet'), ...getOp('note'), ...getOp('tag', messageBody({ deprecated: true })) }),
      );
      expect(errorTypes(spec)).toEqual(['getPet 404: ErrorBody', 'getNote 404: ErrorBody', 'getTag 404: ErrorBody']);
      expect(modelShapes(spec)).toContain('ErrorBody { message }');
      expect(warnings).toEqual([
        '[oagen] Warning: The shared error body "ErrorBody" is declared deprecated by "GetTagError404" and live by "GetNoteError404", "GetPetError404" — keeping it live',
      ]);
    });

    it('a shape every body deprecates is a deprecated model under the same name, so deprecating a lone body is one additive flip, exit 1', async () => {
      const live = await parse(doc(getOp('pet')));
      const deprecated = await parse(doc(getOp('pet', messageBody({ deprecated: true }))));
      expect(deprecated.warnings).toEqual([]);
      expect(errorTypes(deprecated.spec)).toEqual(['getPet 404: ErrorBody']);
      expect(modelShapes(deprecated.spec)).toContain('ErrorBody (deprecated) { message }');
      expect(describeDiff(live.spec, deprecated.spec)).toEqual({
        exitCode: 1,
        changes: ['model-modified ErrorBody deprecatedChanged: additive'],
      });
    });

    it('a live component takes a deprecated body, announced as a deprecated inline copy is; a deprecated component takes none of either flag', async () => {
      const ontoLive = await parse(
        doc({ ...getOp('pet'), ...getOp('tag', messageBody({ deprecated: true })) }, { ErrorBody: messageBody() }),
      );
      expect(errorTypes(ontoLive.spec)).toEqual(['getPet 404: ErrorBody', 'getTag 404: ErrorBody']);
      expect(modelShapes(ontoLive.spec)).toEqual([
        'ErrorBody { message }',
        'GetPetResponse { name }',
        'GetTagResponse { name }',
      ]);
      expect(ontoLive.warnings).toEqual([
        '[oagen] Warning: The shared error body "ErrorBody" is declared deprecated by "GetTagError404" and live by component schema "ErrorBody" — keeping it live',
      ]);
      const ontoDeprecated = await parse(
        doc(
          { ...getOp('pet', messageBody({ deprecated: true })), ...getOp('note', messageBody({ deprecated: true })) },
          { ErrorBody: messageBody({ deprecated: true }) },
        ),
      );
      expect(errorTypes(ontoDeprecated.spec)).toEqual(['getPet 404: GetPetError404', 'getNote 404: GetNoteError404']);
      expect(modelShapes(ontoDeprecated.spec)).toEqual([
        'ErrorBody (deprecated) { message }',
        'GetPetResponse { name }',
        'GetNoteResponse { name }',
        'GetPetError404 (deprecated) { message }',
        'GetNoteError404 (deprecated) { message }',
      ]);
      expect(ontoDeprecated.warnings).toEqual([leftAsTheyAre('deprecated component schema "ErrorBody"')]);
    });

    it('announces a deprecated body a live component takes once, when a name another group cannot take makes the fold run again', async () => {
      // `{ code, message }` asks for `ErrorBodyWithCode`, which a component
      // of another shape holds, so the pass leaves that body and runs again
      // without it; the deprecated `{ message }` folds onto `ErrorBody` in
      // both runs and is announced once (the review's finding).
      const { spec, warnings } = await parse(
        doc(
          { ...getOp('pet', messageBody({ deprecated: true })), ...getOp('note', obj({ code: str, message: str })) },
          { ErrorBody: messageBody(), ErrorBodyWithCode: obj({ reason: str }) },
        ),
      );
      expect(errorTypes(spec)).toEqual(['getPet 404: ErrorBody', 'getNote 404: GetNoteError404']);
      expect(modelShapes(spec)).toContain('ErrorBody { message }');
      expect(warnings).toEqual([
        '[oagen] Warning: The shared error body { code: string, message: string } would be named "ErrorBodyWithCode", which component schema "ErrorBodyWithCode" already holds — keeping model "GetNoteError404" as it is; give the two the same shape, or rename one',
        '[oagen] Warning: The shared error body "ErrorBody" is declared deprecated by "GetPetError404" and live by component schema "ErrorBody" — keeping it live',
      ]);
    });

    it('a nested error body’s own flag is settled among its twins the same way', async () => {
      const item = (deprecated: boolean): Doc =>
        obj({ code: str, field: str }, ['code', 'field'], deprecated ? { deprecated: true } : {});
      const withErrors = (deprecated: boolean): Doc =>
        obj({ message: str, errors: { type: 'array', items: item(deprecated) } }, ['message', 'errors']);
      const { spec, warnings } = await parse(
        doc({ ...getOp('pet', withErrors(false)), ...getOp('note', withErrors(true)) }),
      );
      expect(errorTypes(spec)).toEqual([
        'getPet 404: ErrorBodyWithCodeFieldErrors',
        'getNote 404: ErrorBodyWithCodeFieldErrors',
      ]);
      expect(modelShapes(spec).filter((shape) => shape.startsWith('ErrorBody'))).toEqual([
        'ErrorBodyWithCodeFieldError { code, field }',
        'ErrorBodyWithCodeFieldErrors { message, errors }',
      ]);
      expect(warnings).toEqual([
        '[oagen] Warning: The shared error body "ErrorBodyWithCodeFieldError" is declared deprecated by "GetNoteError404Error" and live by "GetPetError404Error" — keeping it live',
      ]);
    });
  });
});
