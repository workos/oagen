import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectEnumRefs, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

/** Every OpenAPI document under test/fixtures (the `.yml` and `.json` files; configs and sample SDKs are not documents). */
const documents = readdirSync(FIXTURES)
  .filter((file) => /\.(ya?ml|json)$/.test(file))
  .sort();

/**
 * Every type reference a parsed document's bodies hold besides the primary
 * ones: each content entry of every request body, success, error and fallback
 * response, and of every webhook payload — the references the round-2
 * findings on #278 are about — plus every primary body, parameter and field,
 * so an inline enum promoted under any of them is checked too.
 */
function bodyRefs(spec: ApiSpec): Array<{ context: string; type: TypeRef }> {
  const refs: Array<{ context: string; type: TypeRef }> = [];
  for (const service of spec.services) {
    for (const op of service.operations) {
      const at = `${service.name}.${op.name}`;
      if (op.requestBody) refs.push({ context: `${at}.requestBody`, type: op.requestBody });
      refs.push({ context: `${at}.response`, type: op.response });
      for (const content of op.requestBodyContents ?? []) {
        refs.push({ context: `${at}.requestBodyContents.${content.contentType}`, type: content.type });
      }
      for (const content of op.responseContents ?? []) {
        refs.push({ context: `${at}.responseContents.${content.contentType}`, type: content.type });
      }
      for (const entry of op.successResponses ?? []) {
        for (const content of entry.contents ?? []) {
          refs.push({ context: `${at}.${entry.statusCode}.${content.contentType}`, type: content.type });
        }
      }
      for (const error of op.errors) {
        if (error.type) refs.push({ context: `${at}.errors.${error.statusCode}`, type: error.type });
        for (const content of error.contents ?? []) {
          refs.push({ context: `${at}.errors.${error.statusCode}.${content.contentType}`, type: content.type });
        }
      }
      for (const content of op.defaultResponse?.contents ?? []) {
        refs.push({ context: `${at}.default.${content.contentType}`, type: content.type });
      }
      for (const range of op.rangeResponses ?? []) {
        for (const content of range.contents ?? []) {
          refs.push({ context: `${at}.${range.range}.${content.contentType}`, type: content.type });
        }
      }
      for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        refs.push({ context: `${at}.${param.name}`, type: param.type });
      }
    }
  }
  for (const webhook of spec.webhooks ?? []) {
    const at = `webhooks.${webhook.name}.${webhook.httpMethod}`;
    if (webhook.requestBody) refs.push({ context: `${at}.requestBody`, type: webhook.requestBody });
    for (const content of webhook.requestBodyContents ?? []) {
      refs.push({ context: `${at}.requestBodyContents.${content.contentType}`, type: content.type });
    }
  }
  for (const model of spec.models) {
    for (const field of model.fields) refs.push({ context: `${model.name}.${field.name}`, type: field.type });
  }
  return refs;
}

/**
 * The two invariants every parsed document must satisfy: no model and enum
 * share a name (each would reach an emitter as one public symbol), and every
 * reference any body, parameter or field holds resolves — a model reference
 * to a model with its own fields, an enum reference to a promoted enum.
 */
export function expectNameInvariants(spec: ApiSpec): void {
  const modelNames = new Set(spec.models.map((m) => m.name));
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(modelNames.size, 'duplicate model names').toBe(spec.models.length);
  expect(enumNames.size, 'duplicate enum names').toBe(spec.enums.length);
  const shared = [...modelNames].filter((name) => enumNames.has(name));
  expect(shared, 'a model and an enum share a name').toEqual([]);
  for (const { context, type } of bodyRefs(spec)) {
    for (const name of collectModelRefs(type)) {
      const model = spec.models.find((m) => m.name === name);
      expect(model, `${context} references model ${name}`).toBeDefined();
      expect(Array.isArray(model?.fields), `${context}: model ${name} has fields`).toBe(true);
    }
    for (const name of collectEnumRefs(type)) {
      expect(enumNames.has(name), `${context} references enum ${name}`).toBe(true);
    }
    // A reference that still carries inline values was never promoted.
    walkTypeRef(type, {
      enum: (ref) => {
        expect(enumNames.has(ref.name), `${context}: inline enum ${ref.name} promoted`).toBe(true);
      },
    });
  }
}

describe('name invariants over every fixture document', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds the fixture documents', () => {
    expect(documents.length).toBeGreaterThan(10);
  });

  for (const file of documents) {
    it(`${file}: no model and enum share a name, and every body reference resolves`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(join(FIXTURES, file));
      expectNameInvariants(spec);
    });
  }
});
