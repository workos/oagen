import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { sentOnlyComponentNames } from '../../src/parser/inline-models.js';
import {
  BINARY_RESPONSE_MEDIA_TYPES,
  TEXT_RESPONSE_MEDIA_TYPES,
  responseBodyReading,
  unreadResponseBodyType,
} from '../../src/parser/body-media-types.js';
import type { DiffReport } from '../../src/differ/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #610: `sentOnlyComponentNames` followed the `schema` of every media
 * type of a response's `content`, while the operation reader types a body
 * under `application/xml`, `text/xml`, `text/html` or `text/plain` as a
 * string and one under `application/octet-stream` or `application/pdf` as a
 * binary string without reading its schema (`primaryBodySchema`,
 * `typeSecondaryContent`). A `listNotes` body of `$ref: Pet` under one of
 * those typed nothing as `Pet`, yet stopped `Pet` counting as only sent, so
 * `Pet.owner` — requiring `name` — was typed as the looser `PetOwner` again
 * (#400, #540). The walk now reads a response body by exactly the media
 * types whose schema the reader reads (`responseBodyReading`, the one
 * classification both call), and a request body — sent by an operation,
 * received by a webhook or a callback — under every media type that
 * declares a schema, since the body readers type each through it.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/** A `content` map of one media type, declaring `schema` (`$ref: Pet` by default). */
const under = (contentType: string, schema: unknown = ref('Pet')) => ({ content: { [contentType]: { schema } } });
/** The issue's components: `Pet.owner` requires `name`, the component `PetOwner` does not. */
const schemas = {
  Pet: {
    type: 'object',
    properties: { owner: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  },
  PetOwner: { type: 'object', properties: { name: { type: 'string' } } },
};
const ok = { description: 'ok' };
/** `POST /pets` (`createPet`): a request body of `$ref: Pet`, returning `204`. */
const createPet = {
  post: { operationId: 'createPet', requestBody: under('application/json'), responses: { '204': ok } },
};
/** `GET /notes` (`listNotes`) returning `200` with `content`, plus `more` responses. */
const listNotes = (content: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  get: { operationId: 'listNotes', responses: { '200': { ...ok, content }, ...more } },
});
/** `POST /notes` (`postNote`) with a request body of `$ref: Pet` under `contentType`, returning `204`. */
const postNote = (contentType: string) => ({
  post: { operationId: 'postNote', requestBody: under(contentType), responses: { '204': ok } },
});
/** A webhook `noteCreated` whose request body is `$ref: Pet` under `contentType`. */
const noteCreated = (contentType: string) => ({
  noteCreated: { post: { operationId: 'noteCreated', requestBody: under(contentType), responses: { '204': ok } } },
});
const doc = (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi,
  info: { title: 'Pets', version: '1' },
  paths,
  components: { schemas },
  ...extra,
});
/** `sent.json`: #540's document. */
const sent = (openapi: string) => doc(openapi, { '/pets': createPet });
/** `listNotes` beside `createPet`, its `200` declaring `content`. */
const sentAnd = (openapi: string, content: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  doc(openapi, { '/pets': createPet, '/notes': listNotes(content, more) });
/** `xml.json`: `sent.json` plus `listNotes` returning `$ref: Pet` under `application/xml`. */
const xml = (openapi: string) => sentAnd(openapi, under('application/xml').content);

const sorted = (names: Set<string>) => [...names].sort();
/** Each model's fields as `name?: Type`, the way the issue prints them. */
const shapes = (models: Model[]): Record<string, string[]> =>
  Object.fromEntries(
    models.map(({ name, fields }) => [
      name,
      fields.map(
        ({ name, required, type }) =>
          `${name}${required ? '' : '?'}: ${type.kind === 'model' ? type.name : type.kind === 'primitive' ? type.type : type.kind}`,
      ),
    ]),
  );
/** The issue's `sent.json` models: `Pet.owner` keeps `PetOwner2`, requiring `name`. */
const SENT_ONLY = { Pet: ['owner?: PetOwner2'], PetOwner: ['name?: string'], PetOwner2: ['name: string'] };
/** The models when something receives `Pet`: `Pet.owner` shares the looser `PetOwner`. */
const RECEIVED = { Pet: ['owner?: PetOwner'], PetOwner: ['name?: string'] };
const PET: TypeRef = { kind: 'model', name: 'Pet' };
const STRING: TypeRef = { kind: 'primitive', type: 'string' };
const BINARY: TypeRef = { kind: 'primitive', type: 'string', format: 'binary' };

const operation = (spec: ApiSpec, name: string): Operation => {
  const found = spec.services.flatMap((service) => service.operations).find((op) => op.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

const tempDirs: string[] = [];
async function write(spec: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-610-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
  return file;
}
async function parse(spec: Record<string, unknown>): Promise<ApiSpec> {
  return parseSpec(await write(spec));
}

describe('#610', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
    it('types `Pet.owner` as `PetOwner2` beside a `listNotes` body the reader types as a string or binary, as for `sent.json` (the issue’s repro)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(shapes((await parse(sent(openapi))).models)).toEqual(SENT_ONLY);
      const json201 = {
        '201': {
          description: 'created',
          content: { 'application/json': { schema: { type: 'string' } }, ...under('application/xml').content },
        },
      };
      const cases: Array<[string, Record<string, unknown>, TypeRef]> = [
        ['application/xml', xml(openapi), STRING],
        ['text/plain', sentAnd(openapi, under('text/plain').content), STRING],
        ['application/octet-stream', sentAnd(openapi, under('application/octet-stream').content), BINARY],
        [
          'application/xml beside a 201 whose application/json is a string',
          sentAnd(openapi, under('application/xml').content, json201),
          STRING,
        ],
      ];
      for (const [label, spec, type] of cases) {
        const parsed = await parse(spec);
        const op = operation(parsed, 'listNotes');
        // Nothing in the IR receives `Pet`: the body is the string or binary string, and so is its `contents` entry.
        expect(op.response, label).toEqual(type);
        expect(
          op.responseContents?.map((content) => content.type),
          label,
        ).toEqual([type]);
        expect(shapes(parsed.models), label).toEqual(SENT_ONLY);
      }
      // The `201`'s entries are typed the same way: the JSON string from its schema, the XML as a string.
      const created = operation(await parse(sentAnd(openapi, under('application/xml').content, json201)), 'listNotes');
      expect(
        created.successResponses?.map(({ statusCode, type, contents }) => [
          statusCode,
          type,
          contents?.map((c) => c.type),
        ]),
      ).toEqual([
        [200, STRING, [STRING]],
        [201, STRING, [STRING, STRING]],
      ]);
    });

    it('reads a response body by exactly the media types whose schema the reader reads, at every response site', () => {
      const notes = (responses: Record<string, unknown>, components: Record<string, unknown> = {}) =>
        doc(
          openapi,
          { '/pets': createPet, '/notes': { get: { operationId: 'listNotes', responses } } },
          { components: { schemas, ...components } },
        );
      const body = (contentType: string) => ({ ...ok, ...under(contentType) });
      const unread = [
        ...BINARY_RESPONSE_MEDIA_TYPES,
        ...TEXT_RESPONSE_MEDIA_TYPES,
        'Application/XML; charset=utf-8',
        'TEXT/PLAIN',
        'application/pdf; version=1.7',
      ];
      const read = [
        'application/json',
        'application/problem+json',
        'application/*+json',
        '*/*',
        'application/yaml',
        'text/csv',
        'application/atom+xml',
        'image/png',
      ];
      const sites: Array<[string, (contentType: string) => Record<string, unknown>]> = [
        ['a 200', (c) => notes({ '200': body(c) })],
        ['a 201 beside a 200', (c) => notes({ '200': ok, '201': body(c) })],
        ['a 302', (c) => notes({ '200': ok, '302': body(c) })],
        ['a 404', (c) => notes({ '200': ok, '404': body(c) })],
        ['default', (c) => notes({ '200': ok, default: body(c) })],
        ['a 4XX range', (c) => notes({ '200': ok, '4XX': body(c) })],
        ['a 1XX range', (c) => notes({ '200': ok, '1XX': body(c) })],
        [
          'a response shared through components/responses',
          (c) => notes({ '200': { $ref: '#/components/responses/Notes' } }, { responses: { Notes: body(c) } }),
        ],
        [
          'a secondary media type beside an application/json string',
          (c) =>
            notes({
              '200': { ...ok, content: { 'application/json': { schema: { type: 'string' } }, ...under(c).content } },
            }),
        ],
      ];
      for (const [site, build] of sites) {
        for (const contentType of unread) {
          expect(sorted(sentOnlyComponentNames(build(contentType))), `${contentType} at ${site}`).toEqual(['Pet']);
        }
        for (const contentType of read) {
          expect(sorted(sentOnlyComponentNames(build(contentType))), `${contentType} at ${site}`).toEqual([]);
        }
      }
    });

    it('still sends `Pet` from a request body under application/xml, which is typed through its schema into `requestBodyContents`, and receives it from a webhook’s or a callback’s', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // An operation's body: sent, though nothing reads it as `requestBody` — `requestBodyContents` carries `Pet`.
      const request = doc(openapi, { '/notes': postNote('application/xml') });
      expect(sorted(sentOnlyComponentNames(request))).toEqual(['Pet']);
      const parsed = await parse(request);
      const op = operation(parsed, 'postNote');
      expect(op.requestBody).toBeUndefined();
      expect(op.requestBodyContents).toEqual([{ contentType: 'application/xml', type: PET }]);
      expect(shapes(parsed.models)).toEqual(SENT_ONLY);
      // A webhook's body: received, so `Pet.owner` shares the looser `PetOwner`.
      const webhook = doc(openapi, { '/pets': createPet }, { webhooks: noteCreated('application/xml') });
      expect(sorted(sentOnlyComponentNames(webhook))).toEqual([]);
      const parsedWebhook = await parse(webhook);
      expect(parsedWebhook.webhooks?.map((hook) => hook.requestBodyContents)).toEqual([
        [{ contentType: 'application/xml', type: PET }],
      ]);
      expect(shapes(parsedWebhook.models)).toEqual(RECEIVED);
      // A callback's body: received too.
      const callbacks = {
        onNote: {
          '{$request.body#/url}': { post: { requestBody: under('application/xml'), responses: { '204': ok } } },
        },
      };
      const callback = doc(openapi, { '/pets': { post: { ...createPet.post, callbacks } } });
      expect(sorted(sentOnlyComponentNames(callback))).toEqual([]);
      expect(shapes((await parse(callback)).models)).toEqual(RECEIVED);
    });

    it('`oagen diff --old sent.json --new xml.json` reports only the added service, additive, exit 1 (before: `model-removed PetOwner2` and `Pet` modified, exit 2)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(diffSpecs(await parse(sent(openapi)), await parse(xml(openapi))).changes).toEqual([
        { kind: 'service-added', name: 'Notes', classification: 'additive' },
      ]);
      const err: unknown = await diffCommand({ old: await write(sent(openapi)), new: await write(xml(openapi)) }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ exitCode: 1 });
      const printed = JSON.parse(log.mock.calls[0][0] as string) as DiffReport;
      expect(printed.summary).toMatchObject({ added: 1, removed: 0, modified: 0, breaking: 0, additive: 1 });
    });
  });

  it('the operation reader and the sent/received walk agree on every media type the helper knows, on a response, a request and a webhook alike', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const known = [
      ...BINARY_RESPONSE_MEDIA_TYPES,
      ...TEXT_RESPONSE_MEDIA_TYPES,
      'Application/PDF; version=1.7',
      'TEXT/HTML; charset=utf-8',
      'application/json',
      'application/problem+json',
      'application/*+json',
      '*/*',
      'application/yaml',
      'text/csv',
      'application/atom+xml',
      'multipart/form-data',
      'application/x-www-form-urlencoded',
      'image/png',
    ];
    for (const contentType of known) {
      const reading = responseBodyReading(contentType);
      const expected = reading === 'schema' ? PET : unreadResponseBodyType(reading);
      // A response body: typed as the helper says — the primary pick and a
      // secondary entry alike — and reaching `Pet` exactly when read through
      // its schema, so `Pet.owner` is `PetOwner2` exactly when it is not.
      const response = sentAnd('3.1.0', under(contentType).content);
      const parsed = await parse(response);
      const primary = operation(parsed, 'listNotes');
      expect(primary.response, contentType).toEqual(expected);
      expect(primary.responseContents, contentType).toEqual([{ contentType, type: expected }]);
      expect(sorted(sentOnlyComponentNames(response)), contentType).toEqual(reading === 'schema' ? [] : ['Pet']);
      expect(shapes(parsed.models), contentType).toEqual(reading === 'schema' ? RECEIVED : SENT_ONLY);
      const secondary = sentAnd('3.1.0', {
        'application/json': { schema: { type: 'string' } },
        ...under(contentType).content,
      });
      const entry = operation(await parse(secondary), 'listNotes').responseContents?.find(
        (c) => c.contentType === contentType,
      );
      expect(entry?.type, `${contentType} as a secondary entry`).toEqual(expected);
      expect(sorted(sentOnlyComponentNames(secondary)), `${contentType} as a secondary entry`).toEqual(
        reading === 'schema' ? [] : ['Pet'],
      );
      // A request body: every media type that declares a schema is typed through it, so each sends `Pet`.
      const request = doc('3.1.0', { '/notes': postNote(contentType) });
      expect(operation(await parse(request), 'postNote').requestBodyContents, contentType).toEqual([
        { contentType, type: PET },
      ]);
      expect(sorted(sentOnlyComponentNames(request)), contentType).toEqual(['Pet']);
      // A webhook's body: typed the same way, received.
      const webhook = doc('3.1.0', { '/pets': createPet }, { webhooks: noteCreated(contentType) });
      expect(
        (await parse(webhook)).webhooks?.map((hook) => hook.requestBodyContents),
        contentType,
      ).toEqual([[{ contentType, type: PET }]]);
      expect(sorted(sentOnlyComponentNames(webhook)), contentType).toEqual([]);
    }
  });
});
