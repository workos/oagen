import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Operation, ResponseHeader } from '../../src/ir/types.js';

/**
 * Issue #605: since #587 an `allOf` member that declares no type is part of
 * the wrapper, and `extractResponseHeaders` read `deprecated` from such
 * members (`annotatingAllOfMembers`), but a header's `externalDocs` from
 * the schema's own keys alone — so a link written in an annotating member
 * was dropped while the same link beside the `allOf` was the header's. The
 * header now reads both from the one layer a field, a parameter and the
 * model built from the schema read (`allOfWrapperLayer`): the schema's own
 * keys, then the first annotating member's.
 */

const VERSIONS = ['3.1.0', '3.0.3'] as const;
const link = { url: 'https://example.com/rate-limits' };
const other = { url: 'https://example.com/other' };
const own = { url: 'https://example.com/own' };

type Doc = Record<string, unknown>;

/** The issue's member spelling: the link in an annotating member. */
const member: Doc = { allOf: [{ type: 'integer' }, { externalDocs: link }] };
/** The issue's beside spelling: the link beside the `allOf`. */
const beside: Doc = { allOf: [{ type: 'integer' }], externalDocs: link };

/**
 * `GET /pets` (`operationId: listPets`) whose `200` declares `headers`,
 * beside the given parameters, other responses and components.
 */
function petsDoc(
  openapi: string,
  headers: Doc,
  extra: { parameters?: unknown[]; responses?: Doc; components?: Doc } = {},
): Doc {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          ...(extra.parameters ? { parameters: extra.parameters } : {}),
          responses: { '200': { description: 'OK', headers }, ...extra.responses },
        },
      },
    },
    ...(extra.components ? { components: extra.components } : {}),
  };
}

/** Parse `doc` from a temp file, capturing every warning. */
async function parseDoc(doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), 'oagen-605-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(doc));
  try {
    const spec = await parseSpec(specPath);
    return { spec, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}

const operationOf = (spec: ApiSpec): Operation => spec.services.flatMap(({ operations }) => operations)[0];
const headersOf = (spec: ApiSpec): ResponseHeader[] => operationOf(spec).responseHeaders ?? [];
/** The issue's script output for one header. */
const shown = ({ externalDocs, name, type }: ResponseHeader): string =>
  `${name}: ${(type as { type?: string }).type} ${JSON.stringify(externalDocs)}`;
const headerByName = (spec: ApiSpec, name: string): ResponseHeader | undefined =>
  headersOf(spec).find((header) => header.name === name);
const docsOf = (headers: ResponseHeader[]): Record<string, unknown> =>
  Object.fromEntries(headers.map(({ name, externalDocs, deprecated }) => [name, { externalDocs, deprecated }]));

describe('#605', () => {
  it.each(VERSIONS)(
    "reads a header's link from an annotating allOf member (the issue's repro, OAS %s)",
    async (openapi) => {
      const { spec, warnings } = await parseDoc(
        petsDoc(openapi, {
          'X-Rate-Limit': { schema: member },
          'X-Rate-Reset': { schema: beside },
        }),
      );
      expect(warnings).toEqual([]);
      // Before: `X-Rate-Limit: integer undefined`.
      expect(headersOf(spec).map(shown)).toEqual([
        'X-Rate-Limit: integer {"url":"https://example.com/rate-limits"}',
        'X-Rate-Reset: integer {"url":"https://example.com/rate-limits"}',
      ]);
      // The member's position does not matter: the typing member may follow it.
      const reversed = await parseDoc(
        petsDoc(openapi, { 'X-Rate-Limit': { schema: { allOf: [{ externalDocs: link }, { type: 'integer' }] } } }),
      );
      expect(reversed.warnings).toEqual([]);
      expect(headersOf(reversed.spec).map(shown)).toEqual([
        'X-Rate-Limit: integer {"url":"https://example.com/rate-limits"}',
      ]);

      // Non-breaking: the link appears and nothing moves, so `oagen diff`
      // between the two spellings reports nothing, either way.
      const members = await parseDoc(
        petsDoc(openapi, { 'X-Rate-Limit': { schema: member }, 'X-Rate-Reset': { schema: member } }),
      );
      const besides = await parseDoc(
        petsDoc(openapi, { 'X-Rate-Limit': { schema: beside }, 'X-Rate-Reset': { schema: beside } }),
      );
      expect(diffSpecs(members.spec, besides.spec).changes).toEqual([]);
      expect(diffSpecs(besides.spec, members.spec).changes).toEqual([]);
    },
  );

  it.each(VERSIONS)(
    "reads the schema's own link first, then the first member's, an unusable one falling through (OAS %s)",
    async (openapi) => {
      const { spec, warnings } = await parseDoc(
        petsDoc(openapi, {
          // The schema's own link wins over a member's.
          'X-Own': { schema: { allOf: [{ type: 'integer' }, { externalDocs: link }], externalDocs: own } },
          // The first member that declares one wins among members, whichever side of the typing member it sits.
          'X-First': { schema: { allOf: [{ type: 'integer' }, { externalDocs: link }, { externalDocs: other }] } },
          'X-First-Before': {
            schema: { allOf: [{ externalDocs: link }, { type: 'integer' }, { externalDocs: other }] },
          },
          // An unusable link at one level is no link: the next level's stands.
          'X-Blank-Own': {
            schema: { allOf: [{ type: 'integer' }, { externalDocs: link }], externalDocs: { url: '' } },
          },
          'X-Blank-Member': {
            schema: { allOf: [{ type: 'integer' }, { externalDocs: { url: '  ' } }, { externalDocs: link }] },
          },
          // A member that declares no link gives none.
          'X-None': { schema: { allOf: [{ type: 'integer' }, { description: 'Only text.' }] } },
          // The typing member's own link stays on that member, as for a field.
          'X-Typing': { schema: { allOf: [{ type: 'integer', externalDocs: link }] } },
        }),
      );
      expect(warnings).toEqual([]);
      expect(docsOf(headersOf(spec))).toEqual({
        'X-Own': { externalDocs: own, deprecated: undefined },
        'X-First': { externalDocs: link, deprecated: undefined },
        'X-First-Before': { externalDocs: link, deprecated: undefined },
        'X-Blank-Own': { externalDocs: link, deprecated: undefined },
        'X-Blank-Member': { externalDocs: link, deprecated: undefined },
        'X-None': { externalDocs: undefined, deprecated: undefined },
        'X-Typing': { externalDocs: undefined, deprecated: undefined },
      });
      for (const header of headersOf(spec)) expect(header.type).toEqual({ kind: 'primitive', type: 'integer' });
    },
  );

  it.each(VERSIONS)(
    "keeps the Header Object's own description; a member's text and flag are read as before (OAS %s)",
    async (openapi) => {
      const { spec, warnings } = await parseDoc(
        petsDoc(openapi, {
          // `ResponseHeader.description` is the Header Object's alone (docs:
          // "its `description` only the Header Object"); the member's link
          // and flag are the header's.
          'X-Documented': {
            description: 'From the header.',
            schema: {
              allOf: [{ type: 'integer' }, { description: 'From the member.', deprecated: true, externalDocs: link }],
            },
          },
          'X-Undocumented': { schema: { allOf: [{ type: 'integer' }, { description: 'From the member.' }] } },
          // The Header Object's own flag counts, and a member's beside a live schema (#587).
          'X-Flagged': { deprecated: true, schema: { allOf: [{ type: 'integer' }, { externalDocs: link }] } },
          'X-Member-Flagged': {
            schema: { allOf: [{ type: 'integer' }, { deprecated: true }, { externalDocs: link }] },
          },
          // Only a literal `true` is a flag, on the schema and on a member alike.
          'X-Not-Flagged': { schema: { allOf: [{ type: 'integer' }, { deprecated: 'yes' }], deprecated: false } },
        }),
      );
      expect(warnings).toEqual([]);
      expect(
        headersOf(spec).map(({ name, description, deprecated, externalDocs }) => ({
          name,
          description,
          deprecated,
          externalDocs,
        })),
      ).toEqual([
        { name: 'X-Documented', description: 'From the header.', deprecated: true, externalDocs: link },
        { name: 'X-Undocumented', description: undefined, deprecated: undefined, externalDocs: undefined },
        { name: 'X-Flagged', description: undefined, deprecated: true, externalDocs: link },
        { name: 'X-Member-Flagged', description: undefined, deprecated: true, externalDocs: link },
        { name: 'X-Not-Flagged', description: undefined, deprecated: undefined, externalDocs: undefined },
      ]);
    },
  );

  it.each(VERSIONS)(
    'reads the member as a field, a parameter and the model or enum built from the schema already do (OAS %s)',
    async (openapi) => {
      const annotation = { deprecated: true, externalDocs: link };
      const meta = { type: 'object', properties: { etag: { type: 'string' } } };
      const kind = { type: 'string', enum: ['cat', 'dog'] };
      const { spec, warnings } = await parseDoc(
        petsDoc(
          openapi,
          {
            'X-Rate-Limit': { schema: { allOf: [{ type: 'integer' }, annotation] } },
            // An object-shaped header mints a model, an enum header lifts an enum: each carries the layer's link too.
            'X-Meta': { schema: { allOf: [meta, annotation] } },
            'X-Kind': { schema: { allOf: [kind, { externalDocs: link }] } },
          },
          {
            parameters: [{ name: 'limit', in: 'query', schema: { allOf: [{ type: 'integer' }, annotation] } }],
            components: {
              schemas: {
                Pet: { type: 'object', properties: { rateLimit: { allOf: [{ type: 'integer' }, annotation] } } },
              },
            },
          },
        ),
      );
      expect(warnings).toEqual([]);
      const op = operationOf(spec);
      // The header.
      expect(headerByName(spec, 'X-Rate-Limit')).toMatchObject({
        type: { kind: 'primitive', type: 'integer' },
        deprecated: true,
        externalDocs: link,
      });
      // The parameter, as #555 reads it.
      expect(op.queryParams.map(({ name, deprecated, externalDocs }) => ({ name, deprecated, externalDocs }))).toEqual([
        { name: 'limit', deprecated: true, externalDocs: link },
      ]);
      // The field, as #555 reads it.
      const pet = spec.models.find(({ name }) => name === 'Pet');
      expect(pet?.fields.map(({ name, deprecated, externalDocs }) => ({ name, deprecated, externalDocs }))).toEqual([
        { name: 'rateLimit', deprecated: true, externalDocs: link },
      ]);
      // The model built from the header's schema, as #587 reads it, and the header that names it.
      expect(headerByName(spec, 'X-Meta')).toMatchObject({
        type: { kind: 'model', name: 'PetsXMeta' },
        deprecated: true,
        externalDocs: link,
      });
      expect(spec.models.find(({ name }) => name === 'PetsXMeta')).toMatchObject({
        deprecated: true,
        externalDocs: link,
      });
      // The enum lifted from the header's schema, and the header that names it.
      expect(headerByName(spec, 'X-Kind')).toMatchObject({
        type: { kind: 'enum', name: 'PetsXKind' },
        externalDocs: link,
      });
      expect(spec.enums.find(({ name }) => name === 'PetsXKind')).toMatchObject({ externalDocs: link });
    },
  );

  it.each(VERSIONS)(
    'reads the member through a components/headers ref, a content map, an error and a fallback response (OAS %s)',
    async (openapi) => {
      const { spec, warnings } = await parseDoc(
        petsDoc(
          openapi,
          {
            'X-Rate-Limit': { $ref: '#/components/headers/RateLimit' },
            'X-Rate-Json': { content: { 'application/json': { schema: member } } },
          },
          {
            responses: {
              '429': { description: 'Too many.', headers: { 'Retry-After': { schema: member } } },
              default: { description: 'Anything else.', headers: { 'X-Request-Id': { schema: member } } },
            },
            components: { headers: { RateLimit: { description: 'Shared.', schema: member } } },
          },
        ),
      );
      expect(warnings).toEqual([]);
      const op = operationOf(spec);
      expect(
        headersOf(spec).map(({ name, description, externalDocs }) => ({ name, description, externalDocs })),
      ).toEqual([
        { name: 'X-Rate-Limit', description: 'Shared.', externalDocs: link },
        { name: 'X-Rate-Json', description: undefined, externalDocs: link },
      ]);
      expect(op.errors.map(({ statusCode, headers }) => ({ statusCode, headers: headers?.map(shown) }))).toEqual([
        { statusCode: 429, headers: ['Retry-After: integer {"url":"https://example.com/rate-limits"}'] },
      ]);
      expect(op.defaultResponse?.headers?.map(shown)).toEqual([
        'X-Request-Id: integer {"url":"https://example.com/rate-limits"}',
      ]);
    },
  );

  it.each(VERSIONS)(
    "gives the header a member's link beside a $ref member, the component keeping its own (OAS %s)",
    async (openapi) => {
      const metaLink = { url: 'https://example.com/meta' };
      const { spec, warnings } = await parseDoc(
        petsDoc(
          openapi,
          {
            // A bare `$ref` gives the header none: the referenced model carries its own.
            'X-Meta': { schema: { $ref: '#/components/schemas/Meta' } },
            // A member beside the `$ref` is the header's own schema, so its link is the header's.
            'X-Meta-Linked': { schema: { allOf: [{ $ref: '#/components/schemas/Meta' }, { externalDocs: link }] } },
          },
          {
            components: {
              schemas: {
                Meta: { type: 'object', properties: { etag: { type: 'string' } }, externalDocs: metaLink },
              },
            },
          },
        ),
      );
      expect(warnings).toEqual([]);
      expect(headersOf(spec).map(({ name, type, externalDocs }) => ({ name, type, externalDocs }))).toEqual([
        { name: 'X-Meta', type: { kind: 'model', name: 'Meta' }, externalDocs: undefined },
        { name: 'X-Meta-Linked', type: { kind: 'model', name: 'Meta' }, externalDocs: link },
      ]);
      expect(spec.models.find(({ name }) => name === 'Meta')?.externalDocs).toEqual(metaLink);
    },
  );
});
