import { describe, it, expect } from 'vitest';
import {
  assignModelsToServices,
  collectAlternateRequestBodyContents,
  collectRequestBodyModels,
  collectRequestBodyTypes,
  collectWebhookTypeRefs,
} from '../../src/ir/types.js';
import type { Model, Operation, Webhook } from '../../src/ir/types.js';

/**
 * Issue #278: `requestBodyContentTypes` / `requestBodyContents` carry every
 * media type a request body declares, and `collectRequestBodyTypes` is the
 * one place every walker reaches the ones `requestBody` does not share.
 */

const body = { kind: 'model' as const, name: 'ThingInput' };
const xml = { kind: 'model' as const, name: 'ThingXml' };

const op = (over: Partial<Operation>): Operation => ({
  name: 'createThing',
  httpMethod: 'post',
  path: '/things',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'unknown' },
  errors: [],
  injectIdempotencyKey: false,
  ...over,
});

/** A body read from `application/json`, also offered as XML and as CSV text. */
const withContents = op({
  requestBody: body,
  requestBodyEncoding: 'json',
  requestBodyContentType: 'application/json',
  requestBodyContentTypes: ['application/json', 'application/xml', 'text/csv'],
  requestBodyContents: [
    { contentType: 'application/json', type: body },
    { contentType: 'application/xml', type: xml },
    { contentType: 'text/csv', type: { kind: 'primitive', type: 'string' } },
  ],
});

describe('collectAlternateRequestBodyContents', () => {
  it('yields every entry except the one that shares requestBody, by identity', () => {
    expect(collectAlternateRequestBodyContents(withContents).map((c) => c.contentType)).toEqual([
      'application/xml',
      'text/csv',
    ]);
  });

  it('yields an entry whose type merely equals requestBody structurally', () => {
    // The pick's entry shares the very TypeRef object; an equal but distinct
    // object is another body that happens to look the same.
    const copy = op({
      requestBody: body,
      requestBodyContentTypes: ['application/json', 'application/vnd.api+json'],
      requestBodyContents: [
        { contentType: 'application/json', type: body },
        { contentType: 'application/vnd.api+json', type: { ...body } },
      ],
    });
    expect(collectAlternateRequestBodyContents(copy).map((c) => c.contentType)).toEqual(['application/vnd.api+json']);
  });

  it('yields every entry when no media type was read as requestBody, and nothing without contents', () => {
    const unread = op({
      requestBodyContentTypes: ['application/xml'],
      requestBodyContents: [{ contentType: 'application/xml', type: xml }],
    });
    expect(collectAlternateRequestBodyContents(unread).map((c) => c.contentType)).toEqual(['application/xml']);
    expect(collectAlternateRequestBodyContents(op({ requestBody: body }))).toEqual([]);
    expect(collectAlternateRequestBodyContents(op({}))).toEqual([]);
  });
});

describe('collectRequestBodyTypes', () => {
  it('labels each alternate body by its media type', () => {
    expect(collectRequestBodyTypes(withContents)).toEqual([
      { type: xml, source: 'requestBodyContents.application/xml' },
      { type: { kind: 'primitive', type: 'string' }, source: 'requestBodyContents.text/csv' },
    ]);
    expect(collectRequestBodyTypes(op({ requestBody: body }))).toEqual([]);
  });
});

describe('collectRequestBodyModels', () => {
  it('includes models referenced only under a secondary media type', () => {
    const names = collectRequestBodyModels([{ name: 'Things', operations: [withContents] }]);
    expect([...names].sort()).toEqual(['ThingInput', 'ThingXml']);
  });
});

describe('collectWebhookTypeRefs', () => {
  it('includes a secondary payload once and the shared payload once', () => {
    const payload = { kind: 'model' as const, name: 'PetAdoptedPayload' };
    const xmlPayload = { kind: 'model' as const, name: 'PetAdoptedApplicationXmlPayload' };
    const webhook: Webhook = {
      name: 'petAdopted',
      httpMethod: 'post',
      headerParams: [],
      queryParams: [],
      requestBody: payload,
      requestBodyEncoding: 'json',
      requestBodyContentType: 'application/json',
      requestBodyContentTypes: ['application/json', 'application/xml'],
      requestBodyContents: [
        { contentType: 'application/json', type: payload },
        { contentType: 'application/xml', type: xmlPayload },
      ],
      responses: [],
    };
    expect(collectWebhookTypeRefs(webhook)).toEqual([payload, xmlPayload]);
  });
});

describe('assignModelsToServices — request body content types', () => {
  it('assigns a model reached only through a secondary request media type to that service', () => {
    const models: Model[] = [
      { name: 'ThingInput', fields: [] },
      {
        name: 'ThingXml',
        fields: [{ name: 'links', type: { kind: 'model', name: 'ThingXmlLinks' }, required: false }],
      },
      { name: 'ThingXmlLinks', fields: [] },
      { name: 'Unrelated', fields: [] },
    ];
    const map = assignModelsToServices(models, [{ name: 'Things', operations: [withContents] }]);
    expect(map.get('ThingInput')).toBe('Things');
    expect(map.get('ThingXml')).toBe('Things');
    expect(map.get('ThingXmlLinks')).toBe('Things');
    expect(map.get('Unrelated')).toBeUndefined();
  });
});
