import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #613: since #597, `componentAllOfMembers` read a typing
 * `oneOf`/`anyOf` written beside a component's `allOf` as one more member
 * whatever the members declared, while `foldSiblingUnions` folds it for an
 * inline schema only beside an `allOf` that types the schema
 * (`allOfTypesSchema`). So `New: { allOf: [{ description: 'A new pet.' }],
 * oneOf: [Pet, Toy] }` was a model `New { name?, toy? }` with no variants
 * while the same schema inline was `(Pet | Toy)`, and `oagen diff` from the
 * description written beside the `oneOf` exited 2. Both sites now share the
 * predicate: an `allOf` whose members only annotate or limit the schema is
 * part of the wrapper, and the component is the named union — as a `$ref`
 * member, as a variant and under a nullable wrapper alike.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const Pet = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
const Toy = { type: 'object', properties: { toy: { type: 'string' } } };
const Base = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const union = [ref('Pet'), ref('Toy')];

/** The issue's document: `New` as given, the same schema inline as `createPet`'s request body, `New` returned. */
function issueDoc(openapi: string, New: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: { required: true, content: { 'application/json': { schema: New } } },
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('New') } } } },
        },
      },
    },
    components: { schemas: { New, Pet, Toy, ...extra } },
  };
}

const show = (type: TypeRef): string => {
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'model':
    case 'enum':
      return type.name;
    default:
      return type.kind;
  }
};

const plainNew = { description: 'A new pet.', oneOf: union };
const besideNew = { allOf: [{ description: 'A new pet.' }], oneOf: union };

describe.each(['3.1.0', '3.0.3'])('#613 (OAS %s)', (openapi) => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-613-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(doc: unknown): Promise<string> {
    const file = path.join(tmpDir, `spec-${written++}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await write(doc));

  const model = (spec: ApiSpec, name: string): Model => {
    const found = spec.models.find((m) => m.name === name);
    if (!found) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
    return found;
  };
  const operation = (spec: ApiSpec): Operation => spec.services.flatMap((s) => s.operations)[0];
  const fieldsOf = (m: Model) => m.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
  const modelNames = (spec: ApiSpec) => spec.models.map((m) => m.name);

  /** The issue's reading: `New`'s fields and variants, and the request body's type. */
  const reading = (spec: ApiSpec) => {
    const { fields, variants } = model(spec, 'New');
    return {
      fields: fields.map(({ name, required }) => `${name}${required ? '' : '?'}`),
      requestBody: show(operation(spec).requestBody!),
      variants: variants?.map(show),
    };
  };
  const unionReading = { fields: [], requestBody: '(Pet | Toy)', variants: ['Pet', 'Toy'] };

  /** A nullable union in this version's spelling: a `null` variant, or OAS 3.0 `nullable: true`. */
  const nullable = (variants: unknown[]) =>
    openapi === '3.0.3' ? { oneOf: variants, nullable: true } : { oneOf: [...variants, { type: 'null' }] };

  it('the issue: `New` beside `allOf: [{ description }]` is the named union of Pet and Toy, inline and as the component, as with the description beside the oneOf', async () => {
    const plain = await parse(issueDoc(openapi, plainNew));
    const beside = await parse(issueDoc(openapi, besideNew));
    expect(reading(plain)).toEqual(unionReading);
    expect(reading(beside)).toEqual(unionReading);
    expect(model(beside, 'New')).toMatchObject({ description: 'A new pet.', compositionKind: 'oneOf' });
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
    expect(modelNames(beside)).toEqual(['New', 'Pet', 'Toy']);
    expect(show(operation(beside).response)).toBe('New');
    expect(diffSpecs(plain, beside).changes).toEqual([]);
    expect(diffSpecs(beside, plain).changes).toEqual([]);
  });

  it('`oagen diff --old plain.json --new beside.json` exits 0, in either direction', async () => {
    const plain = await write(issueDoc(openapi, plainNew));
    const beside = await write(issueDoc(openapi, besideNew));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [from, to] of [
      [plain, beside],
      [beside, plain],
    ]) {
      const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
      expect(error.exitCode).toBe(0);
    }
  });

  it('`allOf: [{ minProperties: 1 }]` in place of the description: the named union, the limit on its `constraints`, as the limit beside the oneOf', async () => {
    const beside = await parse(issueDoc(openapi, { allOf: [{ minProperties: 1 }], oneOf: union }));
    const plain = await parse(issueDoc(openapi, { minProperties: 1, oneOf: union }));
    expect(reading(beside)).toEqual(unionReading);
    expect(model(beside, 'New')).toMatchObject({ constraints: { minProperties: 1 } });
    expect(model(beside, 'New').description).toBeUndefined();
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
  });

  it('an `anyOf` beside the annotating `allOf` is the named union too', async () => {
    const beside = await parse(issueDoc(openapi, { allOf: [{ description: 'A new pet.' }], anyOf: union }));
    const plain = await parse(issueDoc(openapi, { description: 'A new pet.', anyOf: union }));
    expect(reading(beside)).toEqual(unionReading);
    expect(model(beside, 'New')).toMatchObject({ compositionKind: 'anyOf', description: 'A new pet.' });
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
  });

  it('several annotating members: the first text wins, the limits conjoin with the stricter standing, the flag and the extensions ride', async () => {
    const members = [
      { description: 'A new pet.' },
      { maxProperties: 3, 'x-internal': true },
      { description: 'Other.', maxProperties: 5, deprecated: true },
    ];
    const beside = await parse(issueDoc(openapi, { allOf: members, oneOf: union }));
    const plain = await parse(
      issueDoc(openapi, {
        description: 'A new pet.',
        maxProperties: 3,
        'x-internal': true,
        deprecated: true,
        oneOf: union,
      }),
    );
    expect(reading(beside)).toEqual(unionReading);
    expect(model(beside, 'New')).toMatchObject({
      description: 'A new pet.',
      constraints: { maxProperties: 3 },
      deprecated: true,
      extensions: { 'x-internal': true },
    });
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
  });

  it('a mix of one typing member and annotating members stays the #597 flattening: the union is one more member at both sites', async () => {
    const typing = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const beside = await parse(issueDoc(openapi, { allOf: [typing, { description: 'A new pet.' }], oneOf: union }));
    const member = await parse(issueDoc(openapi, { allOf: [typing, { description: 'A new pet.' }, { oneOf: union }] }));
    expect(reading(beside)).toEqual({
      fields: ['id', 'name?', 'toy?'],
      requestBody: 'CreatePetRequest',
      variants: undefined,
    });
    expect(model(beside, 'New').description).toBe('A new pet.');
    expect(beside.models).toEqual(member.models);
  });

  it('an empty `allOf: []` beside the union types nothing: the named union, as the union alone', async () => {
    const beside = await parse(issueDoc(openapi, { allOf: [], oneOf: union }));
    const plain = await parse(issueDoc(openapi, { oneOf: union }));
    expect(reading(beside)).toEqual(unionReading);
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
  });

  it('the `allOf` and `oneOf` keys in either order read the same', async () => {
    const first = await parse(issueDoc(openapi, { allOf: [{ description: 'A new pet.' }], oneOf: union }));
    const second = await parse(issueDoc(openapi, { oneOf: union, allOf: [{ description: 'A new pet.' }] }));
    expect(reading(second)).toEqual(unionReading);
    expect(second.models).toEqual(first.models);
    expect(diffSpecs(first, second).changes).toEqual([]);
  });

  it('a `$ref` member of a composed component and a variant of another union read the component as the union, as the plain spelling', async () => {
    const extra = { Base, Holder: { allOf: [ref('Base'), ref('New')] }, Other: { oneOf: [ref('New'), ref('Base')] } };
    const plain = await parse(issueDoc(openapi, plainNew, extra));
    const beside = await parse(issueDoc(openapi, besideNew, extra));
    expect(fieldsOf(model(beside, 'Holder'))).toEqual(['id: primitive', 'name?: primitive', 'toy?: primitive']);
    expect(model(beside, 'Other').variants?.map(show)).toEqual(['New', 'Base']);
    expect(beside.models).toEqual(plain.models);
  });

  it("a dispatching union beside the annotating `allOf`, inline as a member: the model dispatches, its variant models are built and carry the members' limits, as the plain spelling", async () => {
    const cat = {
      type: 'object',
      properties: { kind: { const: 'cat' }, meow: { type: 'string' } },
      required: ['kind'],
    };
    const dog = {
      type: 'object',
      properties: { kind: { const: 'dog' }, bark: { type: 'string' } },
      required: ['kind'],
    };
    const holder = (member: Record<string, unknown>) => ({ Base, Holder: { allOf: [ref('Base'), member] } });
    const plain = await parse(
      issueDoc(openapi, plainNew, holder({ description: 'Kinds.', maxProperties: 3, oneOf: [cat, dog] })),
    );
    const beside = await parse(
      issueDoc(
        openapi,
        plainNew,
        holder({ allOf: [{ description: 'Kinds.' }, { maxProperties: 3 }], oneOf: [cat, dog] }),
      ),
    );
    const dispatcher = model(beside, 'Holder');
    expect(dispatcher.discriminator?.property).toBe('kind');
    expect(dispatcher.constraints).toEqual({ maxProperties: 3 });
    const targets = Object.values(dispatcher.discriminator?.mapping ?? {});
    expect(targets).toHaveLength(2);
    // The limit written in the annotating member binds every variant (Greptile review).
    for (const target of targets) {
      expect(modelNames(beside)).toContain(target);
      expect(model(beside, target).constraints, target).toEqual({ maxProperties: 3 });
    }
    expect(beside.models).toEqual(plain.models);
  });

  it("a `required` list in an annotating member beside the union is read as the member's own: `id` stays required inline and through a `$ref`, as the plain spelling (Greptile review)", async () => {
    const idObject = { type: 'object', properties: { id: { type: 'string' } } };
    const extra = (member: Record<string, unknown>) => ({
      Inline: { allOf: [idObject, member] },
      Named: member,
      Through: { allOf: [idObject, ref('Named')] },
    });
    const plain = await parse(issueDoc(openapi, plainNew, extra({ required: ['id'], oneOf: union })));
    const beside = await parse(issueDoc(openapi, plainNew, extra({ allOf: [{ required: ['id'] }], oneOf: union })));
    for (const name of ['Inline', 'Through']) {
      expect(fieldsOf(model(beside, name)), name).toEqual(['id: primitive', 'name?: primitive', 'toy?: primitive']);
      expect(model(beside, name), name).toEqual(model(plain, name));
    }
    expect(model(beside, 'Named').variants?.map(show)).toEqual(['Pet', 'Toy']);
    expect(beside.models).toEqual(plain.models);
  });

  it('a typing `oneOf` and a typing `anyOf` beside the annotating `allOf` stay composed: both unions read as members, as the member spelling (Greptile review)', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((key) => ({
      type: 'object',
      properties: { [key]: { type: 'string' } },
    }));
    const extra = (both: Record<string, unknown>) => ({
      Both: both,
      Through: { allOf: [ref('Base'), ref('Both')] },
      Base,
    });
    const beside = await parse(
      issueDoc(openapi, plainNew, extra({ allOf: [{ description: 'Both.' }], oneOf: [a, b], anyOf: [c, d] })),
    );
    const member = await parse(
      issueDoc(openapi, plainNew, extra({ allOf: [{ description: 'Both.' }, { oneOf: [a, b] }, { anyOf: [c, d] }] })),
    );
    expect(fieldsOf(model(beside, 'Both'))).toEqual([
      'a?: primitive',
      'b?: primitive',
      'c?: primitive',
      'd?: primitive',
    ]);
    expect(model(beside, 'Both').variants).toBeUndefined();
    expect(model(beside, 'Both').description).toBe('Both.');
    expect(fieldsOf(model(beside, 'Through'))).toEqual([
      'id: primitive',
      'a?: primitive',
      'b?: primitive',
      'c?: primitive',
      'd?: primitive',
    ]);
    expect(beside.models).toEqual(member.models);
    expect(diffSpecs(member, beside).changes).toEqual([]);
  });

  it('a nullable union beside the annotating `allOf`: the nullable named union, the body and the reference nullable, as the plain spelling', async () => {
    const plain = await parse(issueDoc(openapi, { description: 'A new pet.', ...nullable(union) }));
    const beside = await parse(issueDoc(openapi, { allOf: [{ description: 'A new pet.' }], ...nullable(union) }));
    expect(model(beside, 'New').variants?.map(show)).toEqual(['Pet', 'Toy']);
    expect(model(beside, 'New').fields).toEqual([]);
    expect(model(beside, 'New')).toEqual(model(plain, 'New'));
    expect(show(operation(beside).requestBody!)).toBe(show(operation(plain).requestBody!));
    expect(show(operation(beside).response)).toBe(show(operation(plain).response));
    if (openapi === '3.1.0') {
      expect(show(operation(beside).requestBody!)).toBe('nullable<(Pet | Toy)>');
      expect(show(operation(beside).response)).toBe('nullable<New>');
    }
  });

  it('a one-variant nullable wrapper beside the annotating `allOf` collapses as it does without it: on a field, as a member and as an array alias', async () => {
    const inlineObject = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const extra = (wrap: (inner: unknown) => Record<string, unknown>) => ({
      Base,
      Pets: { type: 'array', items: ref('Pet') },
      Alias: wrap(ref('Pets')),
      Holder: {
        allOf: [ref('Base'), wrap(ref('Pet'))],
        properties: { f: wrap(ref('Pet')), g: wrap(inlineObject), h: ref('Alias') },
      },
    });
    const plain = await parse(
      issueDoc(
        openapi,
        plainNew,
        extra((inner) => ({ description: 'A new pet.', ...nullable([inner]) })),
      ),
    );
    const beside = await parse(
      issueDoc(
        openapi,
        plainNew,
        extra((inner) => ({ allOf: [{ description: 'A new pet.' }], ...nullable([inner]) })),
      ),
    );
    expect(modelNames(beside)).toEqual(modelNames(plain));
    for (const name of ['Holder', 'HolderG']) {
      expect(fieldsOf(model(beside, name)), name).toEqual(fieldsOf(model(plain, name)));
    }
    if (openapi === '3.1.0') {
      expect(fieldsOf(model(beside, 'Holder'))).toEqual([
        'f?: nullable<Pet>',
        'g?: nullable<HolderG>',
        'h?: nullable<Pet[]>',
        'id: primitive',
        'name: primitive',
      ]);
      expect(modelNames(beside)).not.toContain('Alias');
    }
  });
});
