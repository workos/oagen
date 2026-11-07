import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #580: two webhook stems that collide are told apart by a hash of
 * the `operationId` when the stem is named from one and of the key
 * otherwise, without recording which. A webhook keyed `petAdopted` with no
 * `operationId` and one keyed `noteAdded` declaring `operationId: petAdopted`
 * hashed one string, shared every hashed stem to its last character, and
 * their payloads merged into one model with a warning — the first declared
 * winning, so which payload survived depended on the key order.
 *
 * Now a key and an `operationId` of one text each hash the text prefixed
 * with where it came from (`key:petAdopted`, `operationId:petAdopted`), so
 * the two keep their own payloads whatever the order; a document without
 * such a pair hashes the text as written, as before.
 */

const info = { title: 'repro', version: '1' };

/** A JSON request body carrying `schema`. */
function bodyOfSchema(schema: unknown) {
  return { content: { 'application/json': { schema } } };
}

/** A JSON request body: an object with the one required string property `prop`. */
function bodyOf(prop: string) {
  return bodyOfSchema({ type: 'object', required: [prop], properties: { [prop]: { type: 'string' } } });
}

/** A path item whose POST sends `{ [prop]: string }`, declaring `operationId` when given. */
function posting(prop: string, operationId?: string) {
  return {
    post: {
      ...(operationId !== undefined ? { operationId } : {}),
      requestBody: bodyOf(prop),
      responses: { '200': { description: 'OK' } },
    },
  };
}

/** A document with the given `webhooks` (and paths, components), on `openapi`. */
function documentWith(
  openapi: string,
  webhooks: Record<string, unknown>,
  rest: { paths?: Record<string, unknown>; components?: Record<string, unknown> } = {},
) {
  return { openapi, info, paths: {}, ...rest, webhooks };
}

/** `[name, operationId, payload model]` of each webhook, in document order. */
function payloads(spec: ApiSpec): Array<[string, string | undefined, string | undefined]> {
  return (spec.webhooks ?? []).map((webhook) => [
    webhook.name,
    webhook.operationId,
    webhook.requestBody?.kind === 'model' ? webhook.requestBody.name : undefined,
  ]);
}

/** `[name, field names]` of each model, by name. */
function modelFields(spec: ApiSpec): Array<[string, string[]]> {
  return spec.models
    .map((model): [string, string[]] => [model.name, model.fields.map((field) => field.name)])
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The webhooks by name and the models by name: what must not depend on the key order. */
function orderFree(spec: ApiSpec) {
  return {
    webhooks: [...(spec.webhooks ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    models: [...spec.models].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('#580', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-580-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown, file = 'spec.json'): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, file);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  /** The issue's repro: `petAdopted` without an `operationId`, `noteAdded` declaring `operationId: petAdopted`. */
  const pair = { petAdopted: posting('petId'), noteAdded: posting('noteId', 'petAdopted') };
  const pairReversed = { noteAdded: posting('noteId', 'petAdopted'), petAdopted: posting('petId') };

  describe.each(['3.1.0', '3.0.3'])('on OpenAPI %s', (openapi) => {
    it("gives the issue's two webhooks two payload models, each with its own field, petAdopted first", async () => {
      const spec = await parseJson(documentWith(openapi, pair));
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('gives the same two models with noteAdded first', async () => {
      const spec = await parseJson(documentWith(openapi, pairReversed));
      expect(payloads(spec)).toEqual([
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads identical IR in both key orders', async () => {
      const first = await parseJson(documentWith(openapi, pair), 'first.json');
      const second = await parseJson(documentWith(openapi, pairReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
    });
  });

  it('keeps the pair apart when a component already holds PetAdoptedPayload', async () => {
    const components = { schemas: { PetAdoptedPayload: { type: 'object', properties: { x: { type: 'string' } } } } };
    const spec = await parseJson(documentWith('3.1.0', pair, { components }));
    expect(modelFields(spec)).toEqual([
      ['PetAdopted15Fe0FPayload', ['petId']],
      ['PetAdoptedB0Ca6APayload', ['noteId']],
      ['PetAdoptedPayload', ['x']],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('three stems on one text', () => {
    const three = {
      petAdopted: posting('petId'),
      pet_adopted: posting('otherId'),
      noteAdded: posting('noteId', 'petAdopted'),
    };
    const threeReversed = {
      noteAdded: posting('noteId', 'petAdopted'),
      pet_adopted: posting('otherId'),
      petAdopted: posting('petId'),
    };

    it('hashes the pair by source and the third key as written', async () => {
      const spec = await parseJson(documentWith('3.1.0', three));
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708Payload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
        ['PetAdoptedF79708Payload', ['otherId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads identical IR in both key orders', async () => {
      const first = await parseJson(documentWith('3.1.0', three), 'first.json');
      const second = await parseJson(documentWith('3.1.0', threeReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('a webhook whose own key and operationId spell one text', () => {
    it('is one text, hashed as written, when pet_adopted collides with it', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', { petAdopted: posting('petId', 'petAdopted'), pet_adopted: posting('otherId') }),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', 'petAdopted', 'PetAdoptedB4A950Payload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708Payload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdoptedB4A950Payload', ['petId']],
        ['PetAdoptedF79708Payload', ['otherId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps its plain stem when nothing collides with it', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', { petAdopted: posting('petId', 'petAdopted'), noteAdded: posting('noteId') }),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', 'petAdopted', 'PetAdoptedPayload'],
        ['noteAdded', undefined, 'NoteAddedPayload'],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("petAdopted declaring operationId '-'", () => {
    // `'-'` names nothing and counts as absent (#564), so this is the
    // issue's document: before the fix both orders merged the payloads into
    // one `PetAdoptedB4A950B4535C8Bcfc34E7367252360A1A483FfcbPayload`,
    // the hash spent, with the "more than one definition" warning.
    const dashed = { petAdopted: posting('petId', '-'), noteAdded: posting('noteId', 'petAdopted') };
    const dashedReversed = { noteAdded: posting('noteId', 'petAdopted'), petAdopted: posting('petId', '-') };

    it('gives the two webhooks two payload models, no operationId on petAdopted', async () => {
      const spec = await parseJson(documentWith('3.1.0', dashed));
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads identical IR in both key orders', async () => {
      const first = await parseJson(documentWith('3.1.0', dashed), 'first.json');
      const second = await parseJson(documentWith('3.1.0', dashedReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
    });
  });

  describe('a key that spells a prefixed text', () => {
    // `key:petAdopted` as written is what `petAdopted`'s key hashes once
    // prefixed. Its stem starts with `Key`, so it can mint no name
    // `petAdopted`'s stem mints, hash alike or not, and it moves nothing
    // else: `pet_adopted` beside them keeps the hash of its key as written.
    const literal = { 'key:petAdopted': posting('literalId'), ...pair, pet_adopted: posting('otherId') };
    const literalReversed = {
      pet_adopted: posting('otherId'),
      ...pairReversed,
      'key:petAdopted': posting('literalId'),
    };

    it('still parts every webhook and moves nothing outside the pair', async () => {
      const spec = await parseJson(documentWith('3.1.0', literal));
      expect(payloads(spec)).toEqual([
        ['key:petAdopted', undefined, 'KeyPetAdoptedPayload'],
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708Payload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['KeyPetAdoptedPayload', ['literalId']],
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
        ['PetAdoptedF79708Payload', ['otherId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads identical IR in both key orders', async () => {
      const first = await parseJson(documentWith('3.1.0', literal), 'first.json');
      const second = await parseJson(documentWith('3.1.0', literalReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
    });

    // Colliding itself — `key_pet_adopted` is `KeyPetAdopted` too — it
    // would hash `key:petAdopted`, the very string `petAdopted` hashes, so
    // it hashes its own prefixed text, `key:key:petAdopted`, instead.
    const colliding = { 'key:petAdopted': posting('literalId'), key_pet_adopted: posting('underscoreId'), ...pair };
    const collidingReversed = {
      ...pairReversed,
      key_pet_adopted: posting('underscoreId'),
      'key:petAdopted': posting('literalId'),
    };

    it('hashes its own prefixed text when it collides, never the string the pair hashes', async () => {
      const spec = await parseJson(documentWith('3.1.0', colliding));
      expect(payloads(spec)).toEqual([
        ['key:petAdopted', undefined, 'KeyPetAdopted130B64Payload'],
        ['key_pet_adopted', undefined, 'KeyPetAdopted70A5A5Payload'],
        ['petAdopted', undefined, 'PetAdopted15Fe0FPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['KeyPetAdopted130B64Payload', ['literalId']],
        ['KeyPetAdopted70A5A5Payload', ['underscoreId']],
        ['PetAdopted15Fe0FPayload', ['petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads identical IR in both key orders when it collides', async () => {
      const first = await parseJson(documentWith('3.1.0', colliding), 'first.json');
      const second = await parseJson(documentWith('3.1.0', collidingReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
    });

    // Greptile's document (PR #652): `petAdopted`'s payload is a `oneOf`
    // whose second variant pins `kind: key`, so that variant is named
    // `KeyPetAdopted<hash>Payload` — the literal key's own payload name.
    // Hashing one string, the two would never part and one payload would
    // be dropped; the literal key hashing `key:key:petAdopted` parts them.
    const unionPayload = {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'adopted' }, petId: { type: 'string' } } },
        { type: 'object', properties: { kind: { const: 'key' }, keyId: { type: 'string' } } },
      ],
    };
    const postingUnion = {
      post: { requestBody: bodyOfSchema(unionPayload), responses: { '200': { description: 'OK' } } },
    };
    const variant = {
      petAdopted: postingUnion,
      noteAdded: posting('noteId', 'petAdopted'),
      'key:petAdopted': posting('literalId'),
    };
    const variantReversed = {
      'key:petAdopted': posting('literalId'),
      noteAdded: posting('noteId', 'petAdopted'),
      petAdopted: postingUnion,
    };

    it("keeps the literal key's payload apart from a variant of the pair named like it", async () => {
      const spec = await parseJson(documentWith('3.1.0', variant));
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, undefined],
        ['noteAdded', 'petAdopted', 'PetAdoptedB0Ca6APayload'],
        ['key:petAdopted', undefined, 'KeyPetAdopted130B64Payload'],
      ]);
      const union = spec.webhooks?.[0]?.requestBody;
      expect(union?.kind === 'union' ? union.variants : undefined).toEqual([
        { kind: 'model', name: 'PetAdopted15Fe0FPayload' },
        { kind: 'model', name: 'KeyPetAdopted15Fe0FPayload' },
      ]);
      expect(modelFields(spec)).toEqual([
        ['KeyPetAdopted130B64Payload', ['literalId']],
        ['KeyPetAdopted15Fe0FPayload', ['kind', 'keyId']],
        ['PetAdopted15Fe0FPayload', ['kind', 'petId']],
        ['PetAdoptedB0Ca6APayload', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("reads identical IR in both key orders with the variant named like the literal key's payload", async () => {
      const first = await parseJson(documentWith('3.1.0', variant), 'first.json');
      const second = await parseJson(documentWith('3.1.0', variantReversed), 'second.json');
      expect(orderFree(second)).toEqual(orderFree(first));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('unchanged without a key and an operationId of one text', () => {
    it('hashes two colliding keys as written, as before', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', { petAdopted: posting('petId'), pet_adopted: posting('otherId') }),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdoptedB4A950Payload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708Payload'],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never hashes a key whose several methods qualify its stems past the operationId', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', {
          petAdopted: { ...posting('petId'), put: posting('putId').post },
          noteAdded: posting('noteId', 'petAdopted'),
        }),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdoptedPostPayload'],
        ['petAdopted', undefined, 'PetAdoptedPutPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedPayload'],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('hashes the several methods of two colliding keys as written, parted by the method, as before', async () => {
      // The entries of one key are several groups holding one text under
      // one source: not a key and an operationId of one text, so nothing
      // is prefixed.
      const spec = await parseJson(
        documentWith('3.1.0', {
          petAdopted: { ...posting('petId'), put: posting('putId').post },
          pet_adopted: { ...posting('aId'), put: posting('bId').post },
        }),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdoptedB4A950PostPayload'],
        ['petAdopted', undefined, 'PetAdoptedB4A950PutPayload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708PostPayload'],
        ['pet_adopted', undefined, 'PetAdoptedF79708PutPayload'],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('hashes the prefixed text for a method of the key that collides elsewhere beside the operationId', async () => {
      // The one accepted document whose hashed stem moves: the key's stems
      // never met the operationId's, but `PetAdoptedPost` collides with a
      // component, and the key is held as an operationId too, so it hashes
      // `key:petAdopted` (`PetAdopted15Fe0FPost`), no longer `petAdopted`
      // (`PetAdoptedB4A950Post`).
      const components = {
        schemas: { PetAdoptedPostPayload: { type: 'object', properties: { x: { type: 'string' } } } },
      };
      const spec = await parseJson(
        documentWith(
          '3.1.0',
          {
            petAdopted: { ...posting('petId'), put: posting('putId').post },
            noteAdded: posting('noteId', 'petAdopted'),
          },
          { components },
        ),
      );
      expect(payloads(spec)).toEqual([
        ['petAdopted', undefined, 'PetAdopted15Fe0FPostPayload'],
        ['petAdopted', undefined, 'PetAdoptedPutPayload'],
        ['noteAdded', 'petAdopted', 'PetAdoptedPayload'],
      ]);
      expect(modelFields(spec)).toEqual([
        ['PetAdopted15Fe0FPostPayload', ['petId']],
        ['PetAdoptedPayload', ['noteId']],
        ['PetAdoptedPostPayload', ['x']],
        ['PetAdoptedPutPayload', ['putId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('parts a webhook key from a callback operationId of one text through the reserved names, as before', async () => {
      const paths = {
        '/pets': {
          post: {
            operationId: 'createPet',
            responses: { '200': { description: 'OK' } },
            callbacks: { adopted: { '{$request.body#/callbackUrl}': posting('noteId', 'petAdopted') } },
          },
        },
      };
      const spec = await parseJson(documentWith('3.1.0', { petAdopted: posting('petId') }, { paths }));
      expect(payloads(spec)).toEqual([['petAdopted', undefined, 'PetAdoptedPayload']]);
      const [callback] = spec.services.flatMap((service) => service.operations).flatMap((op) => op.callbacks ?? []);
      expect(callback?.operationId).toBe('petAdopted');
      expect(callback?.requestBody?.kind === 'model' ? callback.requestBody.name : undefined).toBe(
        'PetAdoptedB4A950Payload',
      );
      expect(modelFields(spec)).toEqual([
        ['PetAdoptedB4A950Payload', ['noteId']],
        ['PetAdoptedPayload', ['petId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never collides a webhook key with an operationId of one text on an operation', async () => {
      const paths = {
        '/pets': {
          post: {
            operationId: 'petAdopted',
            requestBody: bodyOf('noteId'),
            responses: { '200': { description: 'OK' } },
          },
        },
      };
      const spec = await parseJson(documentWith('3.1.0', { petAdopted: posting('petId') }, { paths }));
      expect(payloads(spec)).toEqual([['petAdopted', undefined, 'PetAdoptedPayload']]);
      expect(modelFields(spec)).toEqual([
        ['PetAdoptedPayload', ['petId']],
        ['PetAdoptedRequest', ['noteId']],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
