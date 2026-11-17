import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveDataPathFromSchema } from '../../src/parser/responses.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

// #665: `collapseErrorBodies` named a nested error body's array items from
// `singularize(field.name)`, the field name as the document spells it, where
// a component's field hands `singularize` the trailing word of the
// PascalCased name (`qualifyInlineModelName`). The safe list holds PascalCase
// words and was looked up as written, so a lowercase `canvases` missed it and
// fell through to the suffix rules (`ErrorBodyCanvaseWithReason`,
// `ErrorBodySeryWithStep`), and anything else the two spellings read apart —
// a word after a separator (`tax_series`), a short trailing word
// (`invalid_keys`), a name in capitals (`CAUSES`) — named the items another
// way than the same field on a component. The items a `dataPath` hint ends
// in took the singular of the whole PascalCased segment (`TaxSeries` →
// `TaxSery`). Every site now singularizes the trailing word of the
// PascalCased name through one helper (`singularizeTrailingWord`).

type Doc = Record<string, unknown>;
const VERSIONS = ['3.1.0', '3.0.3'] as const;
const info = { title: 'repro', version: '1' };
const str = { type: 'string' };
const json = (schema: Doc) => ({ 'application/json': { schema } });
/** An array of inline objects with one required string field. */
const items = (field: string): Doc => ({
  type: 'array',
  items: { type: 'object', required: [field], properties: { [field]: str } },
});
/** An error body `{ message, ...fields }` that requires `message` and whatever else `required` lists. */
const errorBody = (fields: Doc, required: string[] = []): Doc => ({
  type: 'object',
  required: ['message', ...required],
  properties: { message: str, ...fields },
});
/** An operation returning `200` with `{ id?: string }` and `400` with `body`. */
const operation = (operationId: string, body: Doc): Doc => ({
  operationId,
  responses: {
    '200': { description: 'OK', content: json({ type: 'object', properties: { id: str } }) },
    '400': { description: 'Bad request', content: json(body) },
  },
});
/** `GET /notes` (`listNotes`) and `GET /pets` (`listPets`), both answering `400` with `body`. */
const errorDoc = (body: Doc, openapi: string = '3.1.0'): Doc => ({
  openapi,
  info,
  paths: { '/notes': { get: operation('listNotes', body) }, '/pets': { get: operation('listPets', body) } },
});
/** `GET /pets/{id}` (`getPet`) returning a component `Pet` with `fields`. */
const componentDoc = (fields: Doc, openapi: string = '3.1.0'): Doc => ({
  openapi,
  info,
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: { '200': { description: 'OK', content: json({ $ref: '#/components/schemas/Pet' }) } },
      },
    },
  },
  components: { schemas: { Pet: { type: 'object', properties: fields } } },
});

/** The issue's three fields, exactly as it writes them. */
const issueFields = { canvases: items('reason'), radiuses: items('code'), series: items('step') };

async function withFile<T>(spec: Doc, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-665-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await use(file);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Parse, expecting no `console.warn`. */
async function parse(spec: Doc): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await withFile(spec, (file) => parseSpec(file));
    expect(warn.mock.calls).toEqual([]);
    return ir;
  } finally {
    warn.mockRestore();
  }
}

/** The issue's script: every model, as `Name { field, … }`. */
const show = (spec: ApiSpec, prefix = ''): string[] =>
  spec.models
    .filter(({ name }) => name.startsWith(prefix))
    .map(({ fields, name }) => `${name} { ${fields.map((f) => f.name).join(', ')} }`);
const changes = (a: ApiSpec, b: ApiSpec): string[] =>
  diffSpecs(a, b).changes.map((change) => {
    const name = 'name' in change && typeof change.name === 'string' ? change.name : '';
    return `${change.classification} ${change.kind} ${name}`.trim();
  });
/** The name of the one model that declares `field`. */
function modelWith(spec: ApiSpec, field: string): string {
  const holders = spec.models.filter((m) => m.fields.some((f) => f.name === field)).map((m) => m.name);
  expect(holders, field).toHaveLength(1);
  return holders[0];
}

/** The items an optional `field` of two operations' shared error body are named. */
const errorItems = async (field: string): Promise<string> =>
  modelWith(await parse(errorDoc(errorBody({ [field]: items('reason') }))), 'reason');
/** The items `field` of a component `Pet` are named. */
const componentItems = async (field: string): Promise<string> =>
  modelWith(await parse(componentDoc({ [field]: items('reason') })), 'reason');
/** The items a `dataPath` hint `result.<field>` on `listPets` names from the document. */
function dataPathItems(field: string): string[] | undefined {
  const root: SchemaObject = {
    type: 'object',
    properties: { result: { type: 'object', properties: { [field]: items('id') } } },
  };
  return resolveDataPathFromSchema(root, `result.${field}`, 'ListPetsResponse')?.inlineModels.map((m) => m.name);
}

describe("#665 a shared error body's array items take the singular the field gets on a component", () => {
  describe.each(VERSIONS)('the issue (OAS %s)', (openapi) => {
    it('names the items ErrorBodyCanvasWithReason, ErrorBodyRadiusWithCode and ErrorBodySeriesWithStep', async () => {
      const spec = await parse(errorDoc(errorBody(issueFields), openapi));
      expect(show(spec, 'ErrorBody')).toEqual([
        'ErrorBody { message, canvases, radiuses, series }',
        'ErrorBodyCanvasWithReason { reason }',
        'ErrorBodyRadiusWithCode { code }',
        'ErrorBodySeriesWithStep { step }',
      ]);
      // Both operations' `400` is the one shared body, and nothing keeps an operation's name.
      expect(spec.models.map((m) => m.name).filter((name) => /^List(Notes|Pets)Error/.test(name))).toEqual([]);
      for (const op of spec.services.flatMap((s) => s.operations)) {
        expect(
          op.errors.map((e) => e.type),
          op.name,
        ).toEqual([{ kind: 'model', name: 'ErrorBody' }]);
      }
      const itemsOf = (field: string) =>
        spec.models.find((m) => m.name === 'ErrorBody')?.fields.find((f) => f.name === field)?.type;
      expect(itemsOf('canvases')).toEqual({
        kind: 'array',
        items: { kind: 'model', name: 'ErrorBodyCanvasWithReason' },
      });
      expect(itemsOf('radiuses')).toEqual({ kind: 'array', items: { kind: 'model', name: 'ErrorBodyRadiusWithCode' } });
      expect(itemsOf('series')).toEqual({ kind: 'array', items: { kind: 'model', name: 'ErrorBodySeriesWithStep' } });
    });

    it('names the same three fields on a component Pet PetCanvas, PetRadius and PetSeries', async () => {
      const spec = await parse(componentDoc(issueFields, openapi));
      expect(show(spec)).toEqual([
        'Pet { canvases, radiuses, series }',
        'PetCanvas { reason }',
        'PetRadius { code }',
        'PetSeries { step }',
      ]);
    });

    it('names them the same with the operations and the fields in reverse order', async () => {
      const reversedFields = Object.fromEntries(Object.entries(issueFields).reverse());
      const body = errorBody(reversedFields);
      const reversed = await parse({
        openapi,
        info,
        paths: { '/pets': { get: operation('listPets', body) }, '/notes': { get: operation('listNotes', body) } },
      });
      expect(show(reversed, 'ErrorBody').sort()).toEqual([
        'ErrorBody { message, series, radiuses, canvases }',
        'ErrorBodyCanvasWithReason { reason }',
        'ErrorBodyRadiusWithCode { code }',
        'ErrorBodySeriesWithStep { step }',
      ]);
      // Reordering the operations renames nothing: `oagen diff` reads no model change.
      const original = await parse(errorDoc(errorBody(issueFields), openapi));
      const paths = {
        '/pets': { get: operation('listPets', errorBody(issueFields)) },
        '/notes': { get: operation('listNotes', errorBody(issueFields)) },
      };
      expect(
        changes(original, await parse({ openapi, info, paths })).filter((change) => change.includes('model')),
      ).toEqual([]);
    });

    it('reads an optional property added to an item as one additive change to the item it names', async () => {
      const grown = {
        ...issueFields,
        canvases: {
          type: 'array',
          items: { type: 'object', required: ['reason'], properties: { reason: str, hint: str } },
        },
      };
      const before = await parse(errorDoc(errorBody(issueFields), openapi));
      const after = await parse(errorDoc(errorBody(grown), openapi));
      expect(changes(before, after)).toEqual(['additive model-modified ErrorBodyCanvasWithReason']);
    });
  });

  describe('one item word at every site, however the field is spelled', () => {
    // [the field, the word its items take]. The component column is the
    // control: it read every one of these right before the fix.
    const words: Array<[string, string]> = [
      // The issue's fields, and the other safe-listed words: the word itself and its `-es` plural.
      ['canvases', 'Canvas'],
      ['radiuses', 'Radius'],
      ['series', 'Series'],
      ['species', 'Species'],
      ['status', 'Status'],
      ['statuses', 'Status'],
      ['address', 'Address'],
      ['addresses', 'Address'],
      ['accesses', 'Access'],
      ['progress', 'Progress'],
      ['successes', 'Success'],
      ['alias', 'Alias'],
      ['aliases', 'Alias'],
      ['basis', 'Basis'],
      ['radius', 'Radius'],
      ['canvas', 'Canvas'],
      ['buses', 'Bus'],
      // A safe-listed word after a separator or a case boundary is still the trailing word.
      ['tax_series', 'TaxSeries'],
      ['tax-series', 'TaxSeries'],
      ['taxSeries', 'TaxSeries'],
      ['TaxSeries', 'TaxSeries'],
      ['error_canvases', 'ErrorCanvas'],
      ['order_status', 'OrderStatus'],
      ['shipping_addresses', 'ShippingAddress'],
      ['shipping-addresses', 'ShippingAddress'],
      ['shippingAddresses', 'ShippingAddress'],
      // A trailing word of four letters or fewer is kept, as a whole name that short is.
      ['tags', 'Tags'],
      ['news', 'News'],
      ['item_tags', 'ItemTags'],
      ['invalid_keys', 'InvalidKeys'],
      ['errorIds', 'ErrorIds'],
      // A name in capitals is PascalCased before it is read.
      ['CANVASES', 'Canvas'],
      ['SERIES', 'Series'],
      ['CAUSES', 'Cause'],
      ['TAX_SERIES', 'TaxSeries'],
      ['Canvases', 'Canvas'],
      ['Series', 'Series'],
      // Characters PascalCase drops, and a name that does not end in a word.
      ['causes[]', 'Cause'],
      ['causes2', 'Causes2'],
      ['causes_v2', 'CausesV2'],
      ['v2_causes', 'V2Cause'],
      ['sso_connections', 'SSOConnection'],
      // The suffix rules, as before.
      ['causes', 'Cause'],
      ['boxes', 'Box'],
      ['policies', 'Policy'],
      ['analyses', 'Analysis'],
      ['campuses', 'Campus'],
      ['bonus', 'Bonu'],
    ];

    it.each(words)('%s → %s', async (field, word) => {
      expect(await componentItems(field), 'component').toBe(`Pet${word}`);
      expect(await errorItems(field), 'error body').toBe(`ErrorBody${word}WithReason`);
      expect(dataPathItems(field), 'dataPath').toEqual([`ListPetsResult${word}`]);
    });
  });

  describe('a required field, which the body is named from', () => {
    /** The body and its items, for a required `field` of `{ reason }` items. */
    const requiredNames = async (field: string, openapi: string = '3.1.0'): Promise<string[]> =>
      show(await parse(errorDoc(errorBody({ [field]: items('reason') }, [field]), openapi)), 'ErrorBody').sort();

    it.each(VERSIONS)('replaces the plural the body ends in with its singular (OAS %s)', async (openapi) => {
      expect(await requiredNames('canvases', openapi)).toEqual([
        'ErrorBodyWithReasonCanvas { reason }',
        'ErrorBodyWithReasonCanvases { message, canvases }',
      ]);
      expect(await requiredNames('radiuses', openapi)).toEqual([
        'ErrorBodyWithReasonRadius { reason }',
        'ErrorBodyWithReasonRadiuses { message, radiuses }',
      ]);
      expect(await requiredNames('error_canvases', openapi)).toEqual([
        'ErrorBodyWithReasonErrorCanvas { reason }',
        'ErrorBodyWithReasonErrorCanvases { message, error_canvases }',
      ]);
      expect(await requiredNames('causes', openapi)).toEqual([
        'ErrorBodyWithReasonCause { reason }',
        'ErrorBodyWithReasonCauses { message, causes }',
      ]);
    });

    it.each(VERSIONS)(
      'adds a field that is its own singular to the body, as an object field is added (OAS %s)',
      async (openapi) => {
        // `Series` replaced with `Series` would be the body's own name, which
        // left both models unshared with a warning; the word follows the
        // body instead, as `detail` follows `ErrorBodyWithReasonDetail`.
        expect(await requiredNames('series', openapi)).toEqual([
          'ErrorBodyWithReasonSeries { message, series }',
          'ErrorBodyWithReasonSeriesSeries { reason }',
        ]);
        expect(await requiredNames('status', openapi)).toEqual([
          'ErrorBodyWithReasonStatus { message, status }',
          'ErrorBodyWithReasonStatusStatus { reason }',
        ]);
        expect(await requiredNames('tax_series', openapi)).toEqual([
          'ErrorBodyWithReasonTaxSeries { message, tax_series }',
          'ErrorBodyWithReasonTaxSeriesTaxSeries { reason }',
        ]);
      },
    );

    it("shares a body whose required array is no plural at all, where its items asked for the body's own name", async () => {
      for (const [field, word] of [
        ['tags', 'Tags'],
        ['data', 'Data'],
        ['news', 'News'],
        ['address', 'Address'],
        ['Series', 'Series'],
        ['CANVAS', 'Canvas'],
      ]) {
        expect(await requiredNames(field), field).toEqual([
          `ErrorBodyWithReason${word} { message, ${field} }`,
          `ErrorBodyWithReason${word}${word} { reason }`,
        ]);
      }
    });

    it('names an object field as before: the field follows the body', async () => {
      const detail = { type: 'object', required: ['reason'], properties: { reason: str } };
      const spec = await parse(errorDoc(errorBody({ detail }, ['detail'])));
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBodyWithReasonDetail { message, detail }',
        'ErrorBodyWithReasonDetailDetail { reason }',
      ]);
    });

    it('names two required arrays from the one body: the one it ends in by replacement or doubling, the other after it', async () => {
      const spec = await parse(
        errorDoc(errorBody({ canvases: items('reason'), series: items('step') }, ['canvases', 'series'])),
      );
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBodyWithReasonCanvasesStepSeries { message, canvases, series }',
        'ErrorBodyWithReasonCanvasesStepSeriesCanvas { reason }',
        'ErrorBodyWithReasonCanvasesStepSeriesSeries { step }',
      ]);
      const plural = await parse(
        errorDoc(errorBody({ canvases: items('reason'), radiuses: items('code') }, ['canvases', 'radiuses'])),
      );
      expect(show(plural, 'ErrorBody').sort()).toEqual([
        'ErrorBodyWithReasonCanvasesCodeRadius { code }',
        'ErrorBodyWithReasonCanvasesCodeRadiuses { message, canvases, radiuses }',
        'ErrorBodyWithReasonCanvasesCodeRadiusesCanvas { reason }',
      ]);
    });

    it('adds an optional field that is its own singular after a body that ends in the same word through another field', async () => {
      // `ErrorBodyWithTaxData` is named from the required string `tax_data`;
      // the optional `data` follows it like any field, where replacing `Data`
      // with `Data` dropped the field from the name.
      const spec = await parse(errorDoc(errorBody({ tax_data: str, data: items('reason') }, ['tax_data'])));
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBodyWithTaxData { message, tax_data, data }',
        'ErrorBodyWithTaxDataDataWithReason { reason }',
      ]);
    });
  });

  describe('every other site that names items after a field, which read it this way already (controls)', () => {
    it.each(VERSIONS)(
      'names the items under a request, a response, a parameter, a header and a callback alike (OAS %s)',
      async (openapi) => {
        /** The fields under test, their items told apart by `site` so that no two sites share a model. */
        const fields = (site: string): Doc => ({
          type: 'object',
          properties: {
            canvases: items(`reason_${site}`),
            series: items(`step_${site}`),
            tax_series: items(`rate_${site}`),
          },
        });
        const spec = await parse({
          openapi,
          info,
          paths: {
            '/pets': {
              post: {
                operationId: 'createPet',
                parameters: [{ name: 'filter', in: 'query', content: json(fields('parameter')) }],
                requestBody: { content: json(fields('request')) },
                responses: {
                  '200': {
                    description: 'OK',
                    content: json(fields('response')),
                    headers: { 'X-Meta': { content: json(fields('header')) } },
                  },
                },
                callbacks: {
                  onDone: {
                    '{$request.body#/url}': {
                      post: {
                        operationId: 'petDone',
                        requestBody: { content: json(fields('callback')) },
                        responses: { '200': { description: 'OK' } },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const itemsOf = (parent: string) =>
          spec.models
            .map((m) => m.name)
            .filter((name) => name.startsWith(parent) && name !== parent)
            .sort();
        for (const parent of ['CreatePetRequest', 'CreatePetResponse', 'PetsFilter', 'PetsXMeta', 'PetDonePayload']) {
          expect(itemsOf(parent), parent).toEqual([`${parent}Canvas`, `${parent}Series`, `${parent}TaxSeries`]);
        }
      },
    );

    it('names the items under a webhook payload alike', async () => {
      const spec = await parse({
        openapi: '3.1.0',
        info,
        paths: {},
        webhooks: {
          petCreated: {
            post: {
              operationId: 'petCreated',
              requestBody: {
                content: json({
                  type: 'object',
                  properties: { canvases: items('reason'), series: items('step'), tax_series: items('rate') },
                }),
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      });
      expect(show(spec).sort()).toEqual([
        'PetCreatedPayload { canvases, series, tax_series }',
        'PetCreatedPayloadCanvas { reason }',
        'PetCreatedPayloadSeries { step }',
        'PetCreatedPayloadTaxSeries { rate }',
      ]);
    });
  });

  describe('the array, however it is written', () => {
    it.each(VERSIONS)('reads a nullable array as the array (OAS %s)', async (openapi) => {
      const nullable = (array: Doc): Doc =>
        openapi === '3.1.0' ? { ...array, type: ['array', 'null'] } : { ...array, nullable: true };
      const spec = await parse(
        errorDoc(errorBody({ canvases: nullable(items('reason')), series: nullable(items('step')) }), openapi),
      );
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBody { message, canvases, series }',
        'ErrorBodyCanvasWithReason { reason }',
        'ErrorBodySeriesWithStep { step }',
      ]);
    });

    it('names the items of an array of arrays, and each variant of an array of unions, on the one item word', async () => {
      const obj = (field: string): Doc => ({ type: 'object', required: [field], properties: { [field]: str } });
      const spec = await parse(
        errorDoc(
          errorBody({
            canvases: { type: 'array', items: { type: 'array', items: obj('reason') } },
            series: { type: 'array', items: { oneOf: [obj('step'), obj('code')] } },
          }),
        ),
      );
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBody { message, canvases, series }',
        'ErrorBodyCanvasWithReason { reason }',
        'ErrorBodySeriesWithCode { code }',
        'ErrorBodySeriesWithStep { step }',
      ]);
    });

    it('shares one item model between two fields whose items are one shape, under the name that sorts first', async () => {
      // Whichever field declares it first, in either order.
      for (const fields of [
        { series: items('reason'), canvases: items('reason') },
        { canvases: items('reason'), series: items('reason') },
      ]) {
        const spec = await parse(errorDoc(errorBody(fields)));
        expect(
          show(spec, 'ErrorBody')
            .map((line) => line.split(' ')[0])
            .sort(),
        ).toEqual(['ErrorBody', 'ErrorBodyCanvasWithReason']);
      }
    });

    it('names the items of an array nested in an item from the item, each by its own singular', async () => {
      const canvases = {
        type: 'array',
        items: {
          type: 'object',
          required: ['reason'],
          properties: { reason: str, radiuses: items('code'), series: items('step') },
        },
      };
      const spec = await parse(errorDoc(errorBody({ canvases })));
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBody { message, canvases }',
        'ErrorBodyCanvasWithReason { reason, radiuses, series }',
        'ErrorBodyCanvasWithReasonRadiusWithCode { code }',
        'ErrorBodyCanvasWithReasonSeriesWithStep { step }',
      ]);
    });

    it('tells two shapes under one field apart by their own fields, on the one item word', async () => {
      const spec = await parse({
        openapi: '3.1.0',
        info,
        paths: {
          '/notes': { get: operation('listNotes', errorBody({ series: items('step') })) },
          '/pets': { get: operation('listPets', errorBody({ series: items('code') })) },
        },
      });
      expect(show(spec, 'ErrorBody').sort()).toEqual([
        'ErrorBody { message, series }',
        'ErrorBodySeriesWithCode { code }',
        'ErrorBodySeriesWithStep { step }',
      ]);
    });
  });

  describe('the items a dataPath hint ends in', () => {
    const object = (properties: Doc, required?: string[]): Doc => ({
      type: 'object',
      properties,
      ...(required && { required }),
    });

    it.each(VERSIONS)(
      'takes the path-derived name the trailing word gives, through the parser (OAS %s)',
      async (openapi) => {
        // Each variant's model types its items under a name of its own, so
        // the document answers under the path-derived name.
        const item = object({ id: str });
        const result = (field: string) => ({
          oneOf: [
            object({ [field]: { type: 'array', items: item }, next: str }),
            object({ [field]: { type: 'array', items: item }, total: { type: 'integer' } }),
          ],
        });
        const itemType = async (field: string) => {
          const spec = await parse({
            openapi,
            info,
            paths: {
              '/pets': {
                get: {
                  operationId: 'listPets',
                  parameters: [
                    { name: 'cursor', in: 'query', schema: str },
                    { name: 'limit', in: 'query', schema: { type: 'integer' } },
                  ],
                  responses: {
                    '200': { description: 'OK', content: json(object({ result: result(field) }, ['result'])) },
                  },
                  'x-pagination': { strategy: 'cursor', dataPath: `result.${field}` },
                },
              },
            },
          });
          const type = spec.services.flatMap((s) => s.operations)[0].pagination?.itemType;
          expect(type?.kind === 'model' && spec.models.some((m) => m.name === type.name), field).toBe(true);
          return type;
        };
        expect(await itemType('tax_series')).toEqual({ kind: 'model', name: 'ListPetsResultTaxSeries' });
        expect(await itemType('order_status')).toEqual({ kind: 'model', name: 'ListPetsResultOrderStatus' });
        expect(await itemType('error_canvases')).toEqual({ kind: 'model', name: 'ListPetsResultErrorCanvas' });
        expect(await itemType('invalid_keys')).toEqual({ kind: 'model', name: 'ListPetsResultInvalidKeys' });
        expect(await itemType('responses')).toEqual({ kind: 'model', name: 'ListPetsResultResponse' });
      },
    );
  });
});
