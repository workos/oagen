import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

// #671: since #644 a component `ErrorBody` whose `message` is deprecated took
// no inline error body whose `message` is live, but still took one whose
// `message` is deprecated (`componentAccepts`), so the body's own field flag
// decided whether its error was typed as `ErrorBody` or as its per-operation
// model, and deprecating the body's `message`, or no longer deprecating it,
// renamed the error model: a breaking `oagen diff` for an edit that is
// additive on the body's own model. A component that deprecates a field now
// takes no body carrying that field, of either flag, as a deprecated
// component takes none, so the body keeps its per-operation model and the
// flip is one `field-deprecated-changed` on it.

type Doc = Record<string, unknown>;
const VERSIONS = ['3.1.0', '3.0.3'] as const;
const str: Doc = { type: 'string' };
const deprecatedStr: Doc = { type: 'string', deprecated: true };
/** An object schema requiring `required` (every property unless told), with `keys` beside its `properties`. */
const obj = (properties: Doc, required: string[] = Object.keys(properties), keys: Doc = {}): Doc => ({
  type: 'object',
  required,
  properties,
  ...keys,
});
/** The issue's body and component: `{ message: string }`, `message` required, and deprecated when asked. */
const messageBody = (deprecated: boolean): Doc => obj({ message: deprecated ? deprecatedStr : str });
/** The same body with each flag asked for: its `message`'s (`field`) and its own (`own`). */
const flagged = ({ field = false, own = false }: { field?: boolean; own?: boolean }): Doc =>
  obj({ message: field ? deprecatedStr : str }, ['message'], own ? { deprecated: true } : {});
/** `{ message, hint? }`, `hint` absent, live or deprecated. */
const hinted = (hint: 'none' | 'live' | 'deprecated', more: Doc = {}): Doc =>
  obj({ message: str, ...(hint === 'none' ? {} : { hint: hint === 'live' ? str : deprecatedStr }), ...more }, [
    'message',
  ]);

const json = (schema: Doc): Doc => ({ 'application/json': { schema } });
/** `GET /<name>s` (`get<Name>`) answering `responses` alone. */
const answering = (name: string, responses: Doc): Doc => ({
  [`/${name}s`]: { get: { operationId: `get${name[0].toUpperCase()}${name.slice(1)}`, responses } },
});
/** `GET /<name>s` (`get<Name>`) answering `status` alone with the inline `body`: the issue's operation. */
const op = (name: string, body: Doc, status = '404'): Doc =>
  answering(name, { [status]: { description: 'err', content: json(body) } });

async function parse(spec: Doc, options?: ParseOptions): Promise<{ ir: ApiSpec; warnings: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-671-'));
  const file = path.join(dir, 'spec.json');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    const ir = await parseSpec(file, options);
    return { ir, warnings: warn.mock.calls.map(([message]) => String(message)) };
  } finally {
    warn.mockRestore();
    await fs.rm(dir, { recursive: true });
  }
}

const typeName = (type: TypeRef | undefined): string =>
  type === undefined
    ? 'none'
    : type.kind === 'model'
      ? type.name
      : type.kind === 'union'
        ? type.variants.map(typeName).join(' | ')
        : type.kind;
/**
 * `getNote 404: GetNoteError404` per error site, in document order: what the
 * issue's script prints, with each secondary body of an entry after it
 * (`getNote 404 application/problem+json: …`) and each error range.
 */
const errorTypes = ({ services }: ApiSpec): string[] =>
  services
    .flatMap(({ operations }) => operations)
    .flatMap(({ errors, name, rangeResponses }) =>
      [
        ...errors.map((error) => ({ ...error, key: String(error.statusCode) })),
        ...(rangeResponses ?? []).map((range) => ({ ...range, key: range.range })),
      ].flatMap(({ contents, key, type }) => [
        `${name} ${key}: ${typeName(type)}`,
        ...(contents ?? [])
          .filter((content) => content.type !== type)
          .map((content) => `${name} ${key} ${content.contentType}: ${typeName(content.type)}`),
      ]),
    );
/**
 * `ErrorBody { message (deprecated) }` per model, in list order: what the
 * issue's script prints, with the model's own flag, `?` after an optional
 * field and the name of a field's model or item model.
 */
const modelShapes = ({ models }: ApiSpec): string[] =>
  models.map(
    ({ deprecated, fields, name }) =>
      `${name}${deprecated ? ' (deprecated)' : ''} { ${fields
        .map((field) => {
          const nested =
            field.type.kind === 'model'
              ? `: ${field.type.name}`
              : field.type.kind === 'array' && field.type.items.kind === 'model'
                ? `: ${field.type.items.name}[]`
                : '';
          return `${field.name}${field.required ? '' : '?'}${field.deprecated ? ' (deprecated)' : ''}${nested}`;
        })
        .join(', ')} }`,
  );
/** The exit code `oagen diff` gives a diff (`src/cli/diff.ts`): 2 on a breaking change, 1 on any other change, 0 on none. */
const exitCodeOf = ({ summary }: ReturnType<typeof diffSpecs>): number =>
  summary.breaking > 0 ? 2 : summary.modified > 0 || summary.removed > 0 || summary.added > 0 ? 1 : 0;
interface DiffOutcome {
  changes: string[];
  exitCode: number;
}
/** Every change `oagen diff` reports, as `kind name [flags]: classification`, its field changes indented beneath, with the exit code. */
function describeDiff(oldSpec: ApiSpec, newSpec: ApiSpec): DiffOutcome {
  const diff = diffSpecs(oldSpec, newSpec);
  return {
    exitCode: exitCodeOf(diff),
    changes: diff.changes.flatMap((change) => {
      const rest = change as unknown as Record<string, unknown>;
      const fieldChanges =
        (rest.fieldChanges as Array<{ kind: string; fieldName: string; classification: string }> | undefined) ?? [];
      const flags = Object.keys(rest)
        .filter((key) => key.endsWith('Changed') && rest[key] === true)
        .map((key) => ` ${key}`)
        .join('');
      const label = 'name' in change ? change.name : 'operationName' in change ? change.operationName : undefined;
      return [
        `${change.kind} ${label}${flags}: ${change.classification}`,
        ...fieldChanges.map((field) => `  ${field.kind} ${field.fieldName}: ${field.classification}`),
      ];
    }),
  };
}
/** `oagen diff --old a --new b`, then the reverse. */
async function diffBothWays(a: Doc, b: Doc): Promise<{ forward: DiffOutcome; reverse: DiffOutcome }> {
  const before = (await parse(a)).ir;
  const after = (await parse(b)).ir;
  return { forward: describeDiff(before, after), reverse: describeDiff(after, before) };
}
/** One additive `field-deprecated-changed` on `model`'s `field`, exit 1: what a field's flip costs where it moves no body. */
const fieldFlip = (model: string, field = 'message'): DiffOutcome => ({
  exitCode: 1,
  changes: [`model-modified ${model}: additive`, `  field-deprecated-changed ${field}: additive`],
});
/** One additive `deprecatedChanged` on `model`, exit 1: what a body's own flip costs where it moves no body. */
const ownFlip = (model: string): DiffOutcome => ({
  exitCode: 1,
  changes: [`model-modified ${model} deprecatedChanged: additive`],
});
const NOTHING: DiffOutcome = { exitCode: 0, changes: [] };
/** The same outcome in both directions. */
const eitherWay = (outcome: DiffOutcome) => ({ forward: outcome, reverse: outcome });

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');
/** The rule a warning states for a body that carries `fields`, deprecated on the model `name`. */
const deprecatesRule = (name: string, ...fields: string[]): string =>
  `"${name}" deprecates ${quoted(fields)}, and takes no inline body carrying a field it deprecates, whether the body deprecates the field or not`;
/** The rule a warning states for a body beside a deprecated model `name`. */
const deprecatedRule = (name: string): string =>
  `"${name}" is deprecated, and takes no inline body, deprecated or live`;
/** How the warning ends for a body that nothing but `fields`, deprecated on the model `name`, keeps off it. */
const deprecatesRemedy = (name: string, ...fields: string[]): string =>
  `${deprecatesRule(name, ...fields)}; make ${quoted(fields)} live on "${name}", or rename one`;
const SAME_SHAPE_REMEDY = 'give the two the same shape, or rename one';
/** A copy of `schema` without `key`. */
const without = (schema: Doc, key: string): Doc =>
  Object.fromEntries(Object.entries(schema).filter(([name]) => name !== key));
/** The warning that leaves `models` as they are: the body's `shape`, who holds `name`, and how it ends. */
const leftWarning = (shape: string, name: string, holder: string, models: string[], remedy: string): string =>
  `[oagen] Warning: The shared error body ${shape} would be named "${name}", which ${holder} already holds — keeping ${
    models.length === 1 ? `model ${quoted(models)} as it is` : `models ${quoted(models)} as they are`
  }; ${remedy}`;
/** `ErrorBody { message (deprecated) }` as the warning names its holder. */
const DEPRECATES_MESSAGE = 'component schema "ErrorBody" { message (deprecated): string }';

describe('#671 a component that deprecates a field takes no error body carrying it, of either flag', () => {
  describe.each(VERSIONS)('under OAS %s', (openapi) => {
    const doc = (paths: Doc, schemas: Doc = {}): Doc => ({
      openapi,
      info: { title: 'repro', version: '1' },
      paths,
      components: { schemas },
    });
    /** The issue's `old.json` (`getNote`'s `message` live) and `new.json` (deprecated), beside `ErrorBody { message (deprecated) }`. */
    const issueDoc = (bodyDeprecated: boolean): Doc =>
      doc(op('note', messageBody(bodyDeprecated)), { ErrorBody: messageBody(true) });
    /** The issue's twins: `getNote` and `getPet`, each `message` deprecated when asked, beside the same component. */
    const twins = (note: boolean, pet: boolean, schemas: Doc = { ErrorBody: messageBody(true) }): Doc =>
      doc({ ...op('note', messageBody(note)), ...op('pet', messageBody(pet)) }, schemas);

    describe('the issue’s repro', () => {
      it('`old.json`: the body whose `message` is live keeps `GetNoteError404`, as it did', async () => {
        const { ir, warnings } = await parse(issueDoc(false));
        expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
        expect(modelShapes(ir)).toEqual(['ErrorBody { message (deprecated) }', 'GetNoteError404 { message }']);
        expect(warnings).toEqual([
          '[oagen] Warning: The shared error body { message: string } would be named "ErrorBody", which component schema "ErrorBody" { message (deprecated): string } already holds — keeping model "GetNoteError404" as it is; "ErrorBody" deprecates "message", and takes no inline body carrying a field it deprecates, whether the body deprecates the field or not; make "message" live on "ErrorBody", or rename one',
        ]);
      });

      it('`new.json`: the body whose `message` is deprecated keeps `GetNoteError404` too, where it moved onto `ErrorBody`', async () => {
        const { ir, warnings } = await parse(issueDoc(true));
        expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
        expect(modelShapes(ir)).toEqual([
          'ErrorBody { message (deprecated) }',
          'GetNoteError404 { message (deprecated) }',
        ]);
        // The two print one shape, so the warning ends in the rule and not in "give the two the same shape".
        expect(warnings).toEqual([
          '[oagen] Warning: The shared error body { message (deprecated): string } would be named "ErrorBody", which component schema "ErrorBody" { message (deprecated): string } already holds — keeping model "GetNoteError404" as it is; "ErrorBody" deprecates "message", and takes no inline body carrying a field it deprecates, whether the body deprecates the field or not; make "message" live on "ErrorBody", or rename one',
        ]);
      });

      it('`oagen diff --old old.json --new new.json` is one additive `field-deprecated-changed` on `GetNoteError404`, exit 1, in either direction', async () => {
        expect(await diffBothWays(issueDoc(false), issueDoc(true))).toEqual(eitherWay(fieldFlip('GetNoteError404')));
      });

      it('the model the body keeps is the one it has with the fold off, under either flag', async () => {
        for (const bodyDeprecated of [false, true]) {
          const folded = (await parse(issueDoc(bodyDeprecated))).ir;
          const unfolded = (await parse(issueDoc(bodyDeprecated), { collapseErrorBodies: false })).ir;
          expect(folded.models).toEqual(unfolded.models);
          expect(errorTypes(folded)).toEqual(errorTypes(unfolded));
        }
      });
    });

    describe('among twins', () => {
      it('two bodies that deprecate `message` keep a model each, as beside a deprecated component, where both shared `ErrorBody`', async () => {
        const { ir, warnings } = await parse(twins(true, true));
        expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404', 'getPet 404: GetPetError404']);
        expect(modelShapes(ir)).toEqual([
          'ErrorBody { message (deprecated) }',
          'GetNoteError404 { message (deprecated) }',
          'GetPetError404 { message (deprecated) }',
        ]);
        expect(warnings).toEqual([
          leftWarning(
            '{ message (deprecated): string }',
            'ErrorBody',
            DEPRECATES_MESSAGE,
            ['GetNoteError404', 'GetPetError404'],
            deprecatesRemedy('ErrorBody', 'message'),
          ),
        ]);
        const beside = await parse(twins(true, true, { ErrorBody: flagged({ own: true }) }));
        expect(errorTypes(beside.ir)).toEqual(errorTypes(ir));
        expect(modelShapes(beside.ir).slice(1)).toEqual(modelShapes(ir).slice(1));
      });

      it('no longer deprecating `getPet`’s `message` alone is one additive `field-deprecated-changed` on `GetPetError404`, exit 1, where it moved `getPet` off `ErrorBody`', async () => {
        const { ir } = await parse(twins(true, false));
        expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404', 'getPet 404: GetPetError404']);
        expect(modelShapes(ir)).toEqual([
          'ErrorBody { message (deprecated) }',
          'GetNoteError404 { message (deprecated) }',
          'GetPetError404 { message }',
        ]);
        expect(await diffBothWays(twins(true, true), twins(true, false))).toEqual(
          eitherWay(fieldFlip('GetPetError404')),
        );
      });

      it('every body deprecating its `message` is one such change on each body’s model, exit 1', async () => {
        const each: DiffOutcome = {
          exitCode: 1,
          changes: [...fieldFlip('GetNoteError404').changes, ...fieldFlip('GetPetError404').changes],
        };
        expect(await diffBothWays(twins(false, false), twins(true, true))).toEqual(eitherWay(each));
      });

      it('decides the same whichever operation comes first, whichever of them deprecates `message`', async () => {
        for (const [note, pet] of [
          [true, true],
          [true, false],
          [false, true],
          [false, false],
        ]) {
          const noteFirst = await parse(twins(note, pet));
          const petFirst = await parse(
            doc({ ...op('pet', messageBody(pet)), ...op('note', messageBody(note)) }, { ErrorBody: messageBody(true) }),
          );
          expect([...errorTypes(petFirst.ir)].sort()).toEqual(errorTypes(noteFirst.ir));
          expect([...modelShapes(petFirst.ir)].sort()).toEqual([...modelShapes(noteFirst.ir)].sort());
          expect(petFirst.warnings).toEqual(noteFirst.warnings);
          expect(describeDiff(noteFirst.ir, petFirst.ir)).toEqual(NOTHING);
        }
      });
    });

    describe('no flag a body flips moves it, whatever holds the name', () => {
      // Each holder of `ErrorBody` that takes no `{ message }` body: the body
      // keeps `GetNoteError404` under all four combinations of its two flags.
      const refusing: Array<{ label: string; schemas: Doc }> = [
        { label: 'a component whose `message` is deprecated', schemas: { ErrorBody: flagged({ field: true }) } },
        { label: 'a deprecated component', schemas: { ErrorBody: flagged({ own: true }) } },
        {
          label: 'a deprecated component whose `message` is deprecated',
          schemas: { ErrorBody: flagged({ field: true, own: true }) },
        },
        {
          label: 'a model a component’s `body` field minted, its `message` deprecated',
          schemas: { Error: obj({ body: flagged({ field: true }) }) },
        },
      ];
      it.each(refusing)(
        'beside $label, the body keeps `GetNoteError404` and each flip is one additive change on it',
        async ({ schemas }) => {
          const at = (flags: { field?: boolean; own?: boolean }): Doc => doc(op('note', flagged(flags)), schemas);
          for (const field of [false, true]) {
            for (const own of [false, true]) {
              const { ir, warnings } = await parse(at({ field, own }));
              expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
              expect(modelShapes(ir)).toContain(
                `GetNoteError404${own ? ' (deprecated)' : ''} { message${field ? ' (deprecated)' : ''} }`,
              );
              expect(warnings).toHaveLength(1);
              expect(warnings[0]).toContain('keeping model "GetNoteError404" as it is');
            }
          }
          for (const own of [false, true]) {
            expect(await diffBothWays(at({ own }), at({ field: true, own }))).toEqual(
              eitherWay(fieldFlip('GetNoteError404')),
            );
          }
          for (const field of [false, true]) {
            expect(await diffBothWays(at({ field }), at({ field, own: true }))).toEqual(
              eitherWay(ownFlip('GetNoteError404')),
            );
          }
        },
      );

      it('beside a live component, the body is `ErrorBody` under every flag and no flip is reported, with a warning', async () => {
        const at = (flags: { field?: boolean; own?: boolean }): Doc =>
          doc(op('note', flagged(flags)), { ErrorBody: messageBody(false) });
        for (const flags of [{ field: true }, { own: true }, { field: true, own: true }]) {
          const { ir, warnings } = await parse(at(flags));
          expect(errorTypes(ir)).toEqual(['getNote 404: ErrorBody']);
          expect(modelShapes(ir)).toEqual(['ErrorBody { message }']);
          expect(warnings).toHaveLength(Object.keys(flags).length);
          expect(await diffBothWays(at({}), at(flags))).toEqual(eitherWay(NOTHING));
        }
        expect((await parse(at({ field: true }))).warnings).toEqual([
          '[oagen] Warning: The shared error body "ErrorBody" has "message" declared deprecated by "GetNoteError404" and live by component schema "ErrorBody" — keeping it live',
        ]);
      });

      it('with no holder, a lone body is `ErrorBody` under every flag and carries its own flags', async () => {
        const at = (flags: { field?: boolean; own?: boolean }): Doc => doc(op('note', flagged(flags)));
        expect(await diffBothWays(at({}), at({ field: true }))).toEqual(eitherWay(fieldFlip('ErrorBody')));
        expect(await diffBothWays(at({}), at({ own: true }))).toEqual(eitherWay(ownFlip('ErrorBody')));
      });

      it('twins with no holder still read as `docs/cli.md` says: one body, or one body’s `message`, is no change (exit 0), with a warning; every body, or every body’s `message`, one additive change on `ErrorBody` (exit 1)', async () => {
        type Flags = { field?: boolean; own?: boolean };
        const pair = (note: Flags, pet: Flags): Doc =>
          doc({ ...op('note', flagged(note)), ...op('pet', flagged(pet)) });
        const live = pair({}, {});
        expect(errorTypes((await parse(live)).ir)).toEqual(['getNote 404: ErrorBody', 'getPet 404: ErrorBody']);
        // One body's `message`, then one body.
        const oneField = await parse(pair({}, { field: true }));
        expect(modelShapes(oneField.ir)).toEqual(['ErrorBody { message }']);
        expect(oneField.warnings).toEqual([
          '[oagen] Warning: The shared error body "ErrorBody" has "message" declared deprecated by "GetPetError404" and live by "GetNoteError404" — keeping it live',
        ]);
        expect(await diffBothWays(live, pair({}, { field: true }))).toEqual(eitherWay(NOTHING));
        const oneBody = await parse(pair({}, { own: true }));
        expect(modelShapes(oneBody.ir)).toEqual(['ErrorBody { message }']);
        expect(oneBody.warnings).toEqual([
          '[oagen] Warning: The shared error body "ErrorBody" is declared deprecated by "GetPetError404" and live by "GetNoteError404" — keeping it live',
        ]);
        expect(await diffBothWays(live, pair({}, { own: true }))).toEqual(eitherWay(NOTHING));
        // Every body's `message`, then every body.
        const everyField = await parse(pair({ field: true }, { field: true }));
        expect(everyField.warnings).toEqual([]);
        expect(modelShapes(everyField.ir)).toEqual(['ErrorBody { message (deprecated) }']);
        expect(await diffBothWays(live, pair({ field: true }, { field: true }))).toEqual(
          eitherWay(fieldFlip('ErrorBody')),
        );
        const everyBody = await parse(pair({ own: true }, { own: true }));
        expect(everyBody.warnings).toEqual([]);
        expect(modelShapes(everyBody.ir)).toEqual(['ErrorBody (deprecated) { message }']);
        expect(await diffBothWays(live, pair({ own: true }, { own: true }))).toEqual(eitherWay(ownFlip('ErrorBody')));
      });
    });

    describe('the flip that moves a body is the component’s', () => {
      it('`ErrorBody` deprecating its `message`, or becoming deprecated, moves the body off it under each of the body’s four flag combinations, exit 2', async () => {
        const edits = [
          { component: flagged({ field: true }), flip: fieldFlip('ErrorBody').changes },
          { component: flagged({ own: true }), flip: ownFlip('ErrorBody').changes },
        ];
        for (const { component, flip } of edits) {
          for (const field of [false, true]) {
            for (const own of [false, true]) {
              const body = flagged({ field, own });
              const live = doc(op('note', body), { ErrorBody: messageBody(false) });
              expect(errorTypes((await parse(live)).ir)).toEqual(['getNote 404: ErrorBody']);
              expect(await diffBothWays(live, doc(op('note', body), { ErrorBody: component }))).toEqual({
                forward: {
                  exitCode: 2,
                  changes: [
                    'model-added GetNoteError404: additive',
                    ...flip,
                    'operation-modified getNote errorsChanged: breaking',
                  ],
                },
                reverse: {
                  exitCode: 2,
                  changes: [
                    'model-removed GetNoteError404: breaking',
                    ...flip,
                    'operation-modified getNote errorsChanged: breaking',
                  ],
                },
              });
            }
          }
        }
      });

      it('one edit that deprecates the component’s `message` and the body’s together is the component’s flip too: a string component both reference', async () => {
        // `ErrorBody.message` and the inline body's `message` both `$ref`
        // `Text`, so deprecating `Text` flags the two fields at once.
        const referenced = { $ref: '#/components/schemas/Text' };
        const at = (deprecated: boolean): Doc =>
          doc(op('note', obj({ message: referenced })), {
            ErrorBody: obj({ message: referenced }),
            Text: deprecated ? deprecatedStr : str,
          });
        expect(errorTypes((await parse(at(false))).ir)).toEqual(['getNote 404: ErrorBody']);
        const after = await parse(at(true));
        expect(errorTypes(after.ir)).toEqual(['getNote 404: GetNoteError404']);
        expect(modelShapes(after.ir)).toEqual([
          'ErrorBody { message (deprecated) }',
          'GetNoteError404 { message (deprecated) }',
        ]);
        expect((await diffBothWays(at(false), at(true))).forward).toEqual({
          exitCode: 2,
          changes: [
            'model-added GetNoteError404: additive',
            ...fieldFlip('ErrorBody').changes,
            'operation-modified getNote errorsChanged: breaking',
          ],
        });
      });

      it('the remedies the warning names hold for a body of either flag: `message` made live on `ErrorBody` takes it, and the component renamed frees the name', async () => {
        for (const bodyDeprecated of [false, true]) {
          const body = messageBody(bodyDeprecated);
          const madeLive = await parse(doc(op('note', body), { ErrorBody: messageBody(false) }));
          expect(errorTypes(madeLive.ir)).toEqual(['getNote 404: ErrorBody']);
          expect(modelShapes(madeLive.ir)).toEqual(['ErrorBody { message }']);
          const renamed = await parse(doc(op('note', body), { Problem: messageBody(true) }));
          expect(renamed.warnings).toEqual([]);
          expect(errorTypes(renamed.ir)).toEqual(['getNote 404: ErrorBody']);
          expect(modelShapes(renamed.ir)).toEqual([
            'Problem { message (deprecated) }',
            `ErrorBody { message${bodyDeprecated ? ' (deprecated)' : ''} }`,
          ]);
        }
      });

      it('a body that references the component is the component, beside an inline twin that is not', async () => {
        const { ir } = await parse(
          doc(
            { ...op('note', messageBody(true)), ...op('tag', { $ref: '#/components/schemas/ErrorBody' }) },
            { ErrorBody: messageBody(true) },
          ),
        );
        expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404', 'getTag 404: ErrorBody']);
      });
    });

    describe('only a field the body carries counts', () => {
      /** `ErrorBody { message, hint? }`, its optional `hint` deprecated. */
      const schemas = { ErrorBody: hinted('deprecated') };
      const HOLDER = 'component schema "ErrorBody" { message: string, hint? (deprecated): string }';

      it('a body without the deprecated `hint` folds onto the component; one with a `hint`, deprecated or live, keeps its model', async () => {
        const without = await parse(doc(op('note', hinted('none')), schemas));
        expect(without.warnings).toEqual([]);
        expect(errorTypes(without.ir)).toEqual(['getNote 404: ErrorBody']);
        expect(modelShapes(without.ir)).toEqual(['ErrorBody { message, hint? (deprecated) }']);
        for (const hint of ['live', 'deprecated'] as const) {
          const { ir, warnings } = await parse(doc(op('note', hinted(hint)), schemas));
          expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(modelShapes(ir)).toEqual([
            'ErrorBody { message, hint? (deprecated) }',
            `GetNoteError404 { message, hint?${hint === 'deprecated' ? ' (deprecated)' : ''} }`,
          ]);
          expect(warnings).toEqual([
            leftWarning(
              `{ message: string, hint?${hint === 'deprecated' ? ' (deprecated)' : ''}: string }`,
              'ErrorBody',
              HOLDER,
              ['GetNoteError404'],
              deprecatesRemedy('ErrorBody', 'hint'),
            ),
          ]);
        }
        expect(
          await diffBothWays(doc(op('note', hinted('live')), schemas), doc(op('note', hinted('deprecated')), schemas)),
        ).toEqual(eitherWay(fieldFlip('GetNoteError404', 'hint')));
      });

      it('a body that gains `hint` moves alone, the same under either flag, as one that gains a field the component lacks does', async () => {
        const before = doc({ ...op('note', hinted('none')), ...op('pet', hinted('none')) }, schemas);
        expect(errorTypes((await parse(before)).ir)).toEqual(['getNote 404: ErrorBody', 'getPet 404: ErrorBody']);
        const moved = {
          forward: {
            exitCode: 2,
            changes: ['model-added GetPetError404: additive', 'operation-modified getPet errorsChanged: breaking'],
          },
          reverse: {
            exitCode: 2,
            changes: ['model-removed GetPetError404: breaking', 'operation-modified getPet errorsChanged: breaking'],
          },
        };
        for (const gained of [{ hint: str }, { hint: deprecatedStr }, { more: str }]) {
          const after = doc(
            { ...op('note', hinted('none')), ...op('pet', obj({ message: str, ...gained }, ['message'])) },
            schemas,
          );
          expect(errorTypes((await parse(after)).ir)).toEqual(['getNote 404: ErrorBody', 'getPet 404: GetPetError404']);
          expect(await diffBothWays(before, after)).toEqual(moved);
        }
      });

      it('the bodies one kind of reason keeps off share a warning naming every field among them, and a body that differs in shape too is told both', async () => {
        const both = { ErrorBody: obj({ message: deprecatedStr, hint: deprecatedStr }, ['message']) };
        const holder = 'component schema "ErrorBody" { message (deprecated): string, hint? (deprecated): string }';
        const { ir, warnings } = await parse(
          doc(
            {
              ...op('note', hinted('none')),
              ...op('pet', hinted('deprecated')),
              ...op('tag', hinted('live', { more: str })),
            },
            both,
          ),
        );
        expect(errorTypes(ir)).toEqual([
          'getNote 404: GetNoteError404',
          'getPet 404: GetPetError404',
          'getTag 404: GetTagError404',
        ]);
        expect(warnings).toEqual([
          leftWarning(
            '{ message: string }',
            'ErrorBody',
            holder,
            ['GetNoteError404', 'GetPetError404'],
            deprecatesRemedy('ErrorBody', 'hint', 'message'),
          ),
          leftWarning(
            '{ message: string, hint?: string, more?: string }',
            'ErrorBody',
            holder,
            ['GetTagError404'],
            `${deprecatesRule('ErrorBody', 'hint', 'message')}; give the two the same shape, and make "hint", "message" live on "ErrorBody", or rename one`,
          ),
        ]);
      });

      it('a deprecated component that deprecates `message` too is told as both rules, with a remedy for each', async () => {
        const { warnings } = await parse(
          doc(op('note', messageBody(true)), { ErrorBody: flagged({ field: true, own: true }) }),
        );
        expect(warnings).toEqual([
          leftWarning(
            '{ message (deprecated): string }',
            'ErrorBody',
            'deprecated component schema "ErrorBody" { message (deprecated): string }',
            ['GetNoteError404'],
            `${deprecatedRule('ErrorBody')}; ${deprecatesRule('ErrorBody', 'message')}; make "ErrorBody" live, and make "message" live on "ErrorBody", or rename one`,
          ),
        ]);
      });

      it('announces the deprecated body a component takes once, when a twin that carries its deprecated `hint` makes the fold run again', async () => {
        const { ir, warnings } = await parse(
          doc(
            {
              ...op('note', obj({ message: str }, ['message'], { deprecated: true })),
              ...op('pet', hinted('deprecated')),
            },
            schemas,
          ),
        );
        expect(errorTypes(ir)).toEqual(['getNote 404: ErrorBody', 'getPet 404: GetPetError404']);
        expect(warnings).toEqual([
          leftWarning(
            '{ message: string, hint? (deprecated): string }',
            'ErrorBody',
            HOLDER,
            ['GetPetError404'],
            deprecatesRemedy('ErrorBody', 'hint'),
          ),
          '[oagen] Warning: The shared error body "ErrorBody" is declared deprecated by "GetNoteError404" and live by component schema "ErrorBody" — keeping it live',
        ]);
      });
    });

    describe('the warning names every reason a holder leaves a body for, each with a remedy that holds (the review’s finding 1)', () => {
      const WOULD_BE_NAMED = 'would be named "ErrorBody"';
      const KEEPING = 'keeping model "GetNoteError404" as it is; ';
      /** What a warning's ending tells its reader to do, read from its text. */
      interface Named {
        shape: boolean;
        limits: boolean;
        live: boolean;
        field: boolean;
      }
      const NONE: Named = { shape: false, limits: false, live: false, field: false };
      const namedBy = (warning: string): Named => {
        const ending = warning.slice(warning.indexOf(KEEPING) + KEEPING.length);
        expect(ending.endsWith(', or rename one')).toBe(true);
        return {
          shape: ending.includes('the same shape'),
          limits: ending.includes('the same limits on "message"'),
          live: ending.includes('make "ErrorBody" live'),
          field: ending.includes('make "message" live on "ErrorBody"'),
        };
      };
      /** `give the two the same shape`, on the holder: it declares the body's fields, required as the body requires them. */
      const sameShape = (holder: Doc, body: Doc): Doc => {
        const own = holder.properties as Doc;
        return {
          ...holder,
          required: body.required,
          properties: Object.fromEntries(Object.keys(body.properties as Doc).map((name) => [name, own[name] ?? str])),
        };
      };
      /** `the same limits on "message"`, on the body: it writes the limit the holder writes. */
      const sameLimits = (body: Doc, holder: Doc): Doc => {
        const fields = body.properties as Doc;
        const limit = ((holder.properties as Doc).message as Doc).maxLength;
        return { ...body, properties: { ...fields, message: { ...(fields.message as Doc), maxLength: limit } } };
      };
      /** `make "message" live on "ErrorBody"`. */
      const liveMessage = (holder: Doc): Doc => {
        const fields = holder.properties as Doc;
        return { ...holder, properties: { ...fields, message: without(fields.message as Doc, 'deprecated') } };
      };
      /** The two schemas once the reader has done what `named` says. */
      const follow = (holder: Doc, body: Doc, named: Named): { holder: Doc; body: Doc } => {
        const limited = named.limits ? sameLimits(body, holder) : body;
        let remedied = named.shape ? sameShape(holder, limited) : holder;
        if (named.live) remedied = without(remedied, 'deprecated');
        if (named.field) remedied = liveMessage(remedied);
        return { holder: remedied, body: limited };
      };
      const outcome = async (holder: Doc, body: Doc): Promise<{ error: string; left: string[] }> => {
        const { ir, warnings } = await parse(doc(op('note', body), { ErrorBody: holder }));
        return { error: errorTypes(ir)[0], left: warnings.filter((warning) => warning.includes(WOULD_BE_NAMED)) };
      };

      it('the review’s document: `{ message, hint? }` beside `ErrorBody { message (deprecated) }` is told the rule beside the shape, under either flag on `message`', async () => {
        for (const deprecated of [false, true]) {
          const body = obj({ message: deprecated ? deprecatedStr : str, hint: str }, ['message']);
          const shape = `{ message${deprecated ? ' (deprecated)' : ''}: string, hint?: string }`;
          const first = await parse(doc(op('note', body), { ErrorBody: messageBody(true) }));
          expect(errorTypes(first.ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(first.warnings).toEqual([
            `[oagen] Warning: The shared error body ${shape} would be named "ErrorBody", which component schema "ErrorBody" { message (deprecated): string } already holds — keeping model "GetNoteError404" as it is; "ErrorBody" deprecates "message", and takes no inline body carrying a field it deprecates, whether the body deprecates the field or not; give the two the same shape, and make "message" live on "ErrorBody", or rename one`,
          ]);
          // Half of it, `hint?` added to `ErrorBody`, leaves the body off with the half that is left.
          const shaped = await parse(
            doc(op('note', body), { ErrorBody: obj({ message: deprecatedStr, hint: str }, ['message']) }),
          );
          expect(errorTypes(shaped.ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(shaped.warnings).toEqual([
            leftWarning(
              shape,
              'ErrorBody',
              'component schema "ErrorBody" { message (deprecated): string, hint?: string }',
              ['GetNoteError404'],
              deprecatesRemedy('ErrorBody', 'message'),
            ),
          ]);
          // The other half, `message` made live on `ErrorBody`, leaves it off with the shape.
          const live = await parse(doc(op('note', body), { ErrorBody: messageBody(false) }));
          expect(errorTypes(live.ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(live.warnings).toEqual([
            leftWarning(
              shape,
              'ErrorBody',
              'component schema "ErrorBody" { message: string }',
              ['GetNoteError404'],
              SAME_SHAPE_REMEDY,
            ),
          ]);
          // Both take the body.
          const both = await parse(doc(op('note', body), { ErrorBody: obj({ message: str, hint: str }, ['message']) }));
          expect(errorTypes(both.ir)).toEqual(['getNote 404: ErrorBody']);
          expect(both.warnings).toEqual(
            deprecated
              ? [
                  '[oagen] Warning: The shared error body "ErrorBody" has "message" declared deprecated by "GetNoteError404" and live by component schema "ErrorBody" — keeping it live',
                ]
              : [],
          );
        }
      });

      // Every combination of the four reasons a model that holds `ErrorBody`
      // leaves a `{ message }` body for: another shape (the body has a
      // `hint?` the holder lacks, or the holder requires a `code` the body
      // lacks, which is another key), a limit the body does not write
      // (`maxLength: 3` on `message`), a deprecated holder, and a deprecated
      // `message` on it.
      type Shape = 'alike' | 'optional' | 'required';
      interface Reasons {
        shape: Shape;
        limits: boolean;
        deprecated: boolean;
        deprecates: boolean;
      }
      const combinations: Array<Reasons & { label: string }> = (['alike', 'optional', 'required'] as const)
        .flatMap((shape) =>
          [false, true].flatMap((limits) =>
            [false, true].flatMap((deprecated) =>
              [false, true].map((deprecates): Reasons => ({ shape, limits, deprecated, deprecates })),
            ),
          ),
        )
        .filter(({ shape, limits, deprecated, deprecates }) => shape !== 'alike' || limits || deprecated || deprecates)
        .map((reasons) => ({
          ...reasons,
          label: [
            reasons.shape === 'optional' && 'a `hint?` it lacks',
            reasons.shape === 'required' && 'a `code` it requires',
            reasons.limits && 'a limit on `message`',
            reasons.deprecated && 'its own `deprecated`',
            reasons.deprecates && 'a deprecated `message`',
          ]
            .filter(Boolean)
            .join(', '),
        }));
      const holderOf = ({ shape, limits, deprecated, deprecates }: Reasons): Doc =>
        obj(
          {
            message: { ...str, ...(limits ? { maxLength: 3 } : {}), ...(deprecates ? { deprecated: true } : {}) },
            ...(shape === 'required' ? { code: str } : {}),
          },
          shape === 'required' ? ['message', 'code'] : ['message'],
          deprecated ? { deprecated: true } : {},
        );
      const bodyOf = ({ shape }: Reasons, deprecated: boolean): Doc =>
        obj({ message: deprecated ? deprecatedStr : str, ...(shape === 'optional' ? { hint: str } : {}) }, ['message']);

      it.each(combinations.map((reasons) => [reasons.label, reasons] as const))(
        'a holder that leaves the body for %s names a remedy for each, no other, and following them all takes the body',
        async (_label, reasons) => {
          const holder = holderOf(reasons);
          for (const deprecated of [false, true]) {
            const body = bodyOf(reasons, deprecated);
            const first = await outcome(holder, body);
            expect(first.error).toBe('getNote 404: GetNoteError404');
            expect(first.left).toHaveLength(1);
            // One remedy per reason, and the rule behind each flag.
            const named = namedBy(first.left[0]);
            expect(named).toEqual({
              shape: reasons.shape !== 'alike',
              limits: reasons.limits,
              live: reasons.deprecated,
              field: reasons.deprecates,
            });
            expect(first.left[0].includes(deprecatedRule('ErrorBody'))).toBe(reasons.deprecated);
            expect(first.left[0].includes(deprecatesRule('ErrorBody', 'message'))).toBe(reasons.deprecates);
            // Following every remedy takes the body.
            const all = follow(holder, body, named);
            expect(await outcome(all.holder, all.body)).toEqual({ error: 'getNote 404: ErrorBody', left: [] });
            // Each remedy is needed: leaving one out leaves the body off, and the warning then names that one alone.
            for (const skipped of ['shape', 'limits', 'live', 'field'] as const) {
              if (!named[skipped]) continue;
              const partial = follow(holder, body, { ...named, [skipped]: false });
              const next = await outcome(partial.holder, partial.body);
              expect(next.error).toBe('getNote 404: GetNoteError404');
              expect(next.left).toHaveLength(1);
              expect(namedBy(next.left[0])).toEqual({ ...NONE, [skipped]: true });
            }
            // `or rename one`: with the holder under another name the body is `ErrorBody` itself.
            const renamed = await parse(doc(op('note', body), { Problem: holder }));
            expect(errorTypes(renamed.ir)).toEqual(['getNote 404: ErrorBody']);
            expect(renamed.warnings).toEqual([]);
          }
        },
      );

      it('pins each ending: a limit by its place, a deprecated holder by its rule, every reason at once, and a holder that is no model', async () => {
        const ending = async (holder: Doc, body: Doc = messageBody(false)): Promise<string> => {
          const { left } = await outcome(holder, body);
          expect(left).toHaveLength(1);
          return left[0].slice(left[0].indexOf(KEEPING) + KEEPING.length);
        };
        const limitedMessage = { ...str, maxLength: 3 };
        // The two print one shape here too, so a limit is named by where it is.
        expect(await ending(obj({ message: limitedMessage }))).toBe(
          'give the two the same limits on "message", or rename one',
        );
        expect(await ending(obj({ message: str }, ['message'], { maxProperties: 3 }))).toBe(
          'give the two the same limits of their own, or rename one',
        );
        expect(await ending(obj({ message: limitedMessage }, ['message'], { maxProperties: 3 }))).toBe(
          'give the two the same limits of their own and on "message", or rename one',
        );
        // The models' own limit, written on the body too, takes it.
        expect(
          await outcome(
            obj({ message: str }, ['message'], { maxProperties: 3 }),
            obj({ message: str }, ['message'], { maxProperties: 3 }),
          ),
        ).toEqual({ error: 'getNote 404: ErrorBody', left: [] });
        expect(await ending(flagged({ own: true }))).toBe(
          '"ErrorBody" is deprecated, and takes no inline body, deprecated or live; make "ErrorBody" live, or rename one',
        );
        expect(
          await ending(
            obj({ message: { ...limitedMessage, deprecated: true } }, ['message'], { deprecated: true }),
            hinted('live'),
          ),
        ).toBe(
          '"ErrorBody" is deprecated, and takes no inline body, deprecated or live; "ErrorBody" deprecates "message", and takes no inline body carrying a field it deprecates, whether the body deprecates the field or not; give the two the same shape and the same limits on "message", make "ErrorBody" live, and make "message" live on "ErrorBody", or rename one',
        );
        // Two bodies limits keep off share one warning, which names every place among them.
        const limited = await parse(
          doc(
            { ...op('note', messageBody(false)), ...op('pet', hinted('live')) },
            { ErrorBody: obj({ message: limitedMessage, hint: limitedMessage }, ['message']) },
          ),
        );
        expect(limited.warnings).toEqual([
          leftWarning(
            '{ message: string }',
            'ErrorBody',
            'component schema "ErrorBody" { message: string, hint?: string }',
            ['GetNoteError404', 'GetPetError404'],
            'give the two the same limits on "hint", "message", or rename one',
          ),
        ]);
        // A holder of another shape that shares no flagged field, and one that is no model, are told as they were.
        expect(await ending(obj({ reason: deprecatedStr }))).toBe(SAME_SHAPE_REMEDY);
        expect(await ending({ type: 'string', enum: ['a', 'b'] })).toBe(SAME_SHAPE_REMEDY);
      });
    });

    describe('a nested error body whose name a component holds', () => {
      it('`detail: { reason }` beside `ErrorBodyWithReasonDetailDetail { reason (deprecated) }` keeps its model, and its parent with it, under either flag', async () => {
        const at = (deprecated: boolean): Doc =>
          doc(op('note', obj({ message: str, detail: obj({ reason: deprecated ? deprecatedStr : str }) })), {
            ErrorBodyWithReasonDetailDetail: obj({ reason: deprecatedStr }),
          });
        for (const deprecated of [false, true]) {
          const { ir, warnings } = await parse(at(deprecated));
          expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(modelShapes(ir)).toEqual([
            'ErrorBodyWithReasonDetailDetail { reason (deprecated) }',
            'GetNoteError404 { message, detail: GetNoteError404Detail }',
            `GetNoteError404Detail { reason${deprecated ? ' (deprecated)' : ''} }`,
          ]);
          expect(warnings).toEqual([
            leftWarning(
              `{ reason${deprecated ? ' (deprecated)' : ''}: string }`,
              'ErrorBodyWithReasonDetailDetail',
              'component schema "ErrorBodyWithReasonDetailDetail" { reason (deprecated): string }',
              ['GetNoteError404Detail'],
              deprecatesRemedy('ErrorBodyWithReasonDetailDetail', 'reason'),
            ),
          ]);
        }
        expect(await diffBothWays(at(false), at(true))).toEqual(
          eitherWay(fieldFlip('GetNoteError404Detail', 'reason')),
        );
      });

      it('`errors: [{ code }]` items beside `ErrorBodyWithCodeError { code (deprecated) }` keep theirs the same way', async () => {
        const at = (deprecated: boolean): Doc =>
          doc(
            op(
              'note',
              obj({ message: str, errors: { type: 'array', items: obj({ code: deprecated ? deprecatedStr : str }) } }),
            ),
            { ErrorBodyWithCodeError: obj({ code: deprecatedStr }) },
          );
        for (const deprecated of [false, true]) {
          const { ir } = await parse(at(deprecated));
          expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
          expect(modelShapes(ir)).toEqual([
            'ErrorBodyWithCodeError { code (deprecated) }',
            'GetNoteError404 { message, errors: GetNoteError404Error[] }',
            `GetNoteError404Error { code${deprecated ? ' (deprecated)' : ''} }`,
          ]);
        }
        expect(await diffBothWays(at(false), at(true))).toEqual(eitherWay(fieldFlip('GetNoteError404Error', 'code')));
      });
    });

    describe('at every error site', () => {
      const schemas = { ErrorBody: messageBody(true) };

      it('a `4XX` range’s body keeps its model under either flag', async () => {
        const at = (deprecated: boolean): Doc => doc(op('note', messageBody(deprecated), '4XX'), schemas);
        for (const deprecated of [false, true]) {
          expect(errorTypes((await parse(at(deprecated))).ir)).toEqual(['getNote 4XX: GetNoteError4Xx']);
        }
        expect(await diffBothWays(at(false), at(true))).toEqual(eitherWay(fieldFlip('GetNoteError4Xx')));
      });

      it('a secondary media type’s body keeps its model under either flag', async () => {
        const at = (deprecated: boolean): Doc =>
          doc(
            answering('note', {
              '404': {
                description: 'err',
                content: {
                  'application/json': { schema: obj({ code: str, message: str }) },
                  'application/problem+json': { schema: messageBody(deprecated) },
                },
              },
            }),
            schemas,
          );
        const sites = [errorTypes((await parse(at(false))).ir), errorTypes((await parse(at(true))).ir)];
        expect(sites[1]).toEqual(sites[0]);
        expect(sites[0]).toMatchInlineSnapshot(`
          [
            "getNote 404: ErrorBodyWithCode",
            "getNote 404 application/problem+json: GetNoteError404ApplicationProblemJson",
          ]
        `);
        expect(await diffBothWays(at(false), at(true))).toEqual(
          eitherWay(fieldFlip('GetNoteError404ApplicationProblemJson')),
        );
      });

      it('a `oneOf` variant keeps its model under either flag, beside a variant that folds', async () => {
        const at = (deprecated: boolean): Doc =>
          doc(op('note', { oneOf: [messageBody(deprecated), obj({ code: str, message: str })] }), schemas);
        const sites = [errorTypes((await parse(at(false))).ir), errorTypes((await parse(at(true))).ir)];
        expect(sites[1]).toEqual(sites[0]);
        expect(sites[0]).toMatchInlineSnapshot(`
          [
            "getNote 404: GetNoteError404 | ErrorBodyWithCode",
          ]
        `);
        expect(await diffBothWays(at(false), at(true))).toEqual(eitherWay(fieldFlip('GetNoteError404')));
      });

      it('two status codes of one operation keep a model each, and one of them flipping is one change on its own', async () => {
        const at = (gone: boolean): Doc =>
          doc(
            answering('note', {
              '404': { description: 'err', content: json(messageBody(false)) },
              '410': { description: 'err', content: json(messageBody(gone)) },
            }),
            schemas,
          );
        for (const gone of [false, true]) {
          expect(errorTypes((await parse(at(gone))).ir)).toEqual([
            'getNote 404: GetNoteError404',
            'getNote 410: GetNoteError410',
          ]);
        }
        expect(await diffBothWays(at(false), at(true))).toEqual(eitherWay(fieldFlip('GetNoteError410')));
      });
    });

    describe('in every family a shared name is read from', () => {
      const flag = (deprecated: boolean): Doc => (deprecated ? { deprecated: true } : {});
      // Each body beside a component of its own schema, named as the fold
      // would name the body, with `field` deprecated.
      const families: Array<{ label: string; name: string; field: string; body: (deprecated: boolean) => Doc }> = [
        {
          label: 'a body named from the value it pins',
          name: 'GoneErrorBody',
          field: 'code',
          body: (deprecated) => obj({ code: { type: 'string', enum: ['gone'], ...flag(deprecated) }, message: str }),
        },
        {
          label: 'the OAuth error format',
          name: 'OAuthErrorBody',
          field: 'error_description',
          body: (deprecated) => obj({ error: str, error_description: { ...str, ...flag(deprecated) } }),
        },
        {
          label: 'a body that requires no field',
          name: 'OptionalErrorBody',
          field: 'message',
          body: (deprecated) => obj({ message: { ...str, ...flag(deprecated) } }, []),
        },
        {
          label: 'a body with a further array field',
          name: 'ErrorBodyWithTagsList',
          field: 'tags',
          body: (deprecated) => obj({ message: str, tags: { type: 'array', items: str, ...flag(deprecated) } }),
        },
      ];
      it.each(families)(
        '$label keeps its model beside `$name` deprecating `$field`, under either flag',
        async ({ name, field, body }) => {
          const at = (deprecated: boolean): Doc => doc(op('note', body(deprecated)), { [name]: body(true) });
          for (const deprecated of [false, true]) {
            const { ir, warnings } = await parse(at(deprecated));
            expect(errorTypes(ir)).toEqual(['getNote 404: GetNoteError404']);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain(`would be named "${name}", which component schema "${name}"`);
            expect(warnings[0]).toContain(`keeping model "GetNoteError404" as it is; ${deprecatesRemedy(name, field)}`);
          }
          expect(await diffBothWays(at(false), at(true))).toEqual(eitherWay(fieldFlip('GetNoteError404', field)));
          // With the field live on the component, the body folds onto it under either flag.
          for (const deprecated of [false, true]) {
            const live = await parse(doc(op('note', body(deprecated)), { [name]: body(false) }));
            expect(errorTypes(live.ir)).toEqual([`getNote 404: ${name}`]);
          }
        },
      );
    });
  });
});
