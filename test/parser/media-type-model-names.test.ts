import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('keeps two spellings of one essence side by side apart: equal shapes share the model, different shapes step to the next free name (the status-code-qualified one first)', async () => {
    const same = await parseDocument(
      document({
        'application/yaml': { schema: obj({ title: str }) },
        'application/yaml; charset=utf-8': { schema: obj({ title: str }) },
      }),
    );
    expect(secondaryTypes(same)).toEqual([
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
      { kind: 'model', name: 'GetReportApplicationYamlResponse' },
    ]);
    expect(same.models.filter((m) => m.name.startsWith('GetReportApplicationYaml'))).toHaveLength(1);

    const different = await parseDocument(
      document({
        'application/yaml': { schema: obj({ title: str }) },
        'application/yaml; charset=utf-8': { schema: obj({ summary: str }) },
      }),
    );
    const [first, second] = secondaryTypes(different);
    expect(first).toEqual({ kind: 'model', name: 'GetReportApplicationYamlResponse' });
    // A taken name is re-derived with the status code first, then numbered — the registry's usual path.
    expect(second).toEqual({ kind: 'model', name: 'GetReportApplicationYamlResponse200' });
    expect(fieldsOf(different, 'GetReportApplicationYamlResponse')).toEqual(['title']);
    expect(fieldsOf(different, 'GetReportApplicationYamlResponse200')).toEqual(['summary']);
    // Every model minted for a secondary body is referenced, and every reference resolves.
    const minted = different.models.filter((m) => m.name !== 'Report').map((m) => m.name);
    const referenced = secondaryTypes(different).map((t) => (t.kind === 'model' ? t.name : ''));
    expect(minted.sort()).toEqual([...new Set(referenced)].sort());
  });
});
