import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { createExampleBuilder, STRING_FORMAT_SAMPLES } from '../../src/snippets/example-builder.js';
import type { ApiSpec, Field, Model, Operation, Parameter, TypeRef } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

/**
 * Issue #734: `createExampleBuilder` gave a `date-time` or `date` string a
 * sample in its format, and a string with one of the other date and time
 * formats — `date-time-local`, `time-local`, `time` — the plain
 * `string_example`, a value the API rejects. The builder now asks one table
 * (`STRING_FORMAT_SAMPLES`) that has a row for every string format the
 * OpenAPI format registry defines for a date, a time or a span of time, so
 * `http-date`, `unixtime` and `duration` get a sample as well. All of them
 * but `duration` write the instant of the `date-time` sample.
 */

const PLAIN = 'string_example';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function parse(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-734-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

function emptySpec(models: Model[] = []): ApiSpec {
  return {
    name: 'TestApi',
    version: '1.0.0',
    baseUrl: 'https://api.test.com',
    services: [],
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/** A string schema with a `format`, and whatever else is written beside it. */
const formatted = (format: string, beside: Record<string, unknown> = {}) => ({ type: 'string', format, ...beside });
/** A string type with a `format`, as the IR carries it. */
const stringOf = (format?: unknown): TypeRef =>
  ({ kind: 'primitive', type: 'string', ...(format === undefined ? {} : { format }) }) as TypeRef;

const modelNamed = (spec: ApiSpec, name: string): Model => {
  const model = spec.models.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`no model ${name}`);
  return model;
};
const onlyOperation = (spec: ApiSpec): Operation => {
  const operations = spec.services.flatMap((service) => service.operations);
  expect(operations).toHaveLength(1);
  return operations[0]!;
};

/** The issue's five properties, in the issue's order. */
const noteProperties: [string, Record<string, unknown>][] = [
  ['createdAt', formatted('date-time')],
  ['dueOn', formatted('date')],
  ['remindAt', formatted('date-time-local')],
  ['remindTime', formatted('time-local')],
  ['sentTime', formatted('time')],
];

/** The issue's document: `POST /notes` (`createNote`) taking `$ref: Note` and returning `204`. */
function issueDocument(openapi: string, properties = noteProperties) {
  return {
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/notes': {
        post: {
          operationId: 'createNote',
          requestBody: { content: { 'application/json': { schema: ref('Note') } } },
          responses: { '204': { description: 'No content' } },
        },
      },
    },
    components: { schemas: { Note: { type: 'object', properties: Object.fromEntries(properties) } } },
  };
}

/** What the issue's script prints. */
async function issueScript(doc: unknown): Promise<string> {
  const spec = await parse(doc);
  const note = spec.models.find(({ name }) => name === 'Note');
  return JSON.stringify(createExampleBuilder(spec).forModel(note!), null, 2);
}

describe('#734 a date-time-local, time-local or time string gets a sample in its format', () => {
  it("prints the issue's expected samples for the issue's document (OAS 3.1.0)", async () => {
    // Before #734 the last three were "string_example".
    expect(await issueScript(issueDocument('3.1.0'))).toMatchInlineSnapshot(`
      "{
        "createdAt": "2026-01-15T12:00:00.000Z",
        "dueOn": "2026-01-15",
        "remindAt": "2026-01-15T12:00:00",
        "remindTime": "12:00:00",
        "sentTime": "12:00:00Z"
      }"
    `);
  });

  /** The issue's expected samples, by property. */
  const expected = {
    createdAt: '2026-01-15T12:00:00.000Z',
    dueOn: '2026-01-15',
    remindAt: '2026-01-15T12:00:00',
    remindTime: '12:00:00',
    sentTime: '12:00:00Z',
  };

  it('prints the same for the same document as OAS 3.0.3', async () => {
    expect(await issueScript(issueDocument('3.0.3'))).toBe(JSON.stringify(expected, null, 2));
  });

  it.each(['3.1.0', '3.0.3'])(
    'gives each property the same sample when the properties are written in the other order (OAS %s)',
    async (openapi) => {
      const backward = JSON.parse(await issueScript(issueDocument(openapi, [...noteProperties].reverse())));
      expect(Object.keys(backward)).toEqual(Object.keys(expected).reverse());
      expect(backward).toEqual(expected);
    },
  );

  it('leaves the IR as it was: each field still carries its format and nothing else', async () => {
    const spec = await parse(issueDocument('3.1.0'));
    expect(modelNamed(spec, 'Note').fields.map((field) => [field.name, field.type])).toEqual([
      ['createdAt', stringOf('date-time')],
      ['dueOn', stringOf('date')],
      ['remindAt', stringOf('date-time-local')],
      ['remindTime', stringOf('time-local')],
      ['sentTime', stringOf('time')],
    ]);
  });
});

describe('#734 every date and time string format of the OpenAPI format registry has a sample', () => {
  const builder = createExampleBuilder(emptySpec());
  const sample = (format: string) => builder.forType(stringOf(format));

  it.each([
    // The two the builder knew before #734, unchanged.
    ['date-time', '2026-01-15T12:00:00.000Z'],
    ['date', '2026-01-15'],
    // The three the issue reports.
    ['date-time-local', '2026-01-15T12:00:00'],
    ['time-local', '12:00:00'],
    ['time', '12:00:00Z'],
    // The registry's other date and time formats for a string.
    ['http-date', 'Thu, 15 Jan 2026 12:00:00 GMT'],
    ['unixtime', '1768478400'],
    ['duration', 'P1D'],
  ])('%s: %s', (format, expected) => {
    expect(sample(format)).toBe(expected);
  });

  it('writes one instant, the one of the date-time sample, in every format that names an instant', () => {
    const dateTime = sample('date-time') as string;
    const instant = new Date(dateTime);
    expect(instant.toISOString()).toBe(dateTime);
    // RFC 3339 `full-date` "T" `partial-time` `time-offset`, cut at each part.
    const fullDate = dateTime.slice(0, 10);
    const timeToSeconds = dateTime.slice(11, 19);
    expect(sample('date')).toBe(fullDate);
    expect(sample('date-time-local')).toBe(`${fullDate}T${timeToSeconds}`);
    expect(sample('time-local')).toBe(timeToSeconds);
    expect(sample('time')).toBe(`${timeToSeconds}Z`);
    expect(sample('http-date')).toBe(instant.toUTCString());
    expect(sample('unixtime')).toBe(String(instant.getTime() / 1000));
  });

  it('writes each sample as its format is defined, which the plain sample is not', () => {
    const timeToSeconds = /^\d{2}:\d{2}:\d{2}(\.\d+)?$/;
    const durationTime = /^T(\d+H(\d+M(\d+S)?)?|\d+M(\d+S)?|\d+S)$/;
    const durationDate = /^(\d+Y(\d+M(\d+D)?)?|\d+M(\d+D)?|\d+D)$/;
    const grammar: Record<string, (value: string) => boolean> = {
      // RFC 3339 date-time without the time zone: `full-date` "T" `partial-time`.
      'date-time-local': (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value),
      // RFC 3339 `partial-time`.
      'time-local': (value) => timeToSeconds.test(value),
      // RFC 3339 `full-time`: `partial-time` and `time-offset`.
      time: (value) => /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value),
      // RFC 7231 `IMF-fixdate`.
      'http-date': (value) =>
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
          value,
        ),
      // Seconds since the epoch.
      unixtime: (value) => /^\d+$/.test(value),
      // RFC 3339 `duration`: "P" and a date part, a time part, both, or weeks.
      duration: (value) => {
        if (!value.startsWith('P')) return false;
        const rest = value.slice(1);
        if (/^\d+W$/.test(rest)) return true;
        const at = rest.indexOf('T');
        if (at === -1) return durationDate.test(rest);
        if (at === 0) return durationTime.test(rest);
        return durationDate.test(rest.slice(0, at)) && durationTime.test(rest.slice(at));
      },
    };
    for (const [format, wellFormed] of Object.entries(grammar)) {
      expect([format, wellFormed(sample(format) as string)]).toEqual([format, true]);
      expect([format, wellFormed(PLAIN)]).toEqual([format, false]);
    }
  });

  it('lists every format the builder knows in the one table the builder asks', () => {
    expect([...STRING_FORMAT_SAMPLES.keys()].sort()).toEqual([
      'date',
      'date-time',
      'date-time-local',
      'duration',
      'email',
      'http-date',
      'time',
      'time-local',
      'unixtime',
      'uri',
      'url',
      'uuid',
    ]);
    for (const [format, expected] of STRING_FORMAT_SAMPLES)
      expect([format, sample(format)]).toEqual([format, expected]);
  });
});

describe.each(['3.1.0', '3.0.3'])('#734 the format is read wherever a string is written (OAS %s)', (openapi) => {
  const is30 = openapi.startsWith('3.0');
  /** A string that may be null, as each version spells it. */
  const nullable = (format: string) =>
    is30 ? formatted(format, { nullable: true }) : { type: ['string', 'null'], format };

  const document = () => ({
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/notes/{at}': {
        post: {
          operationId: 'createNote',
          parameters: [
            { name: 'at', in: 'path', required: true, schema: formatted('date-time-local') },
            { name: 'since', in: 'query', schema: formatted('time') },
            { name: 'until', in: 'query', schema: formatted('time-local') },
            { name: 'window', in: 'query', schema: formatted('duration') },
            { name: 'epoch', in: 'query', schema: formatted('unixtime') },
            { name: 'slots', in: 'query', schema: { type: 'array', items: formatted('time-local') } },
            { name: 'If-Modified-Since', in: 'header', schema: formatted('http-date') },
            { name: 'last_seen', in: 'cookie', schema: formatted('date-time-local') },
          ],
          requestBody: {
            content: {
              'application/json': {
                // An inline body, so its fields are read where the operation writes them.
                schema: {
                  type: 'object',
                  properties: { opensAt: formatted('time-local'), note: ref('Note') },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              headers: { 'Last-Modified': { schema: formatted('http-date') } },
              content: { 'application/json': { schema: ref('Note') } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        // A primitive component: a `$ref` to it is the string, format and all.
        RemindAt: formatted('date-time-local'),
        Note: {
          type: 'object',
          properties: {
            remindAt: formatted('date-time-local'),
            viaRef: ref('RemindAt'),
            viaAllOf: { allOf: [ref('RemindAt')] },
            maybe: nullable('time'),
            maybeOneOf: { oneOf: [formatted('time-local'), is30 ? { nullable: true } : { type: 'null' }] },
            times: { type: 'array', items: formatted('time') },
            byDay: { type: 'object', additionalProperties: formatted('time-local') },
            either: { oneOf: [formatted('date-time-local'), { type: 'integer' }] },
            nested: { type: 'object', properties: { modified: formatted('http-date') } },
            ttl: formatted('duration'),
            stamp: formatted('unixtime'),
          },
        },
      },
    },
  });

  it('a field, through a $ref, a nullable, an array, a map, a union and a nested object', async () => {
    const spec = await parse(document());
    expect(createExampleBuilder(spec).forModel('Note')).toEqual({
      remindAt: '2026-01-15T12:00:00',
      viaRef: '2026-01-15T12:00:00',
      viaAllOf: '2026-01-15T12:00:00',
      maybe: '12:00:00Z',
      maybeOneOf: '12:00:00',
      times: ['12:00:00Z'],
      byDay: { key: '12:00:00' },
      either: '2026-01-15T12:00:00',
      nested: { modified: 'Thu, 15 Jan 2026 12:00:00 GMT' },
      ttl: 'P1D',
      stamp: '1768478400',
    });
  });

  it('a path, query, header and cookie parameter', async () => {
    const spec = await parse(document());
    const builder = createExampleBuilder(spec);
    const operation = onlyOperation(spec);
    const parameters: Parameter[] = [
      ...operation.pathParams,
      ...operation.queryParams,
      ...operation.headerParams,
      ...(operation.cookieParams ?? []),
    ];
    expect(parameters.map((parameter) => [parameter.name, builder.forParameter(parameter)])).toEqual([
      ['at', '2026-01-15T12:00:00'],
      ['since', '12:00:00Z'],
      ['until', '12:00:00'],
      ['window', 'P1D'],
      ['epoch', '1768478400'],
      ['slots', ['12:00:00']],
      ['If-Modified-Since', 'Thu, 15 Jan 2026 12:00:00 GMT'],
      ['last_seen', '2026-01-15T12:00:00'],
    ]);
  });

  it('an inline request body and a response header', async () => {
    const spec = await parse(document());
    const builder = createExampleBuilder(spec);
    const operation = onlyOperation(spec);
    expect(operation.requestBody?.kind).toBe('model');
    const body = builder.forType(operation.requestBody!) as Record<string, unknown>;
    expect(body.opensAt).toBe('12:00:00');
    expect((body.note as Record<string, unknown>).remindAt).toBe('2026-01-15T12:00:00');
    expect(operation.responseHeaders?.map((header) => [header.name, builder.forType(header.type)])).toEqual([
      ['Last-Modified', 'Thu, 15 Jan 2026 12:00:00 GMT'],
    ]);
  });
});

describe('#734 the format is read in a webhook payload (OAS 3.1.0)', () => {
  it("gives the payload model of a webhook its fields' samples", async () => {
    const spec = await parse({
      openapi: '3.1.0',
      info: { title: 'Repro', version: '1.0.0' },
      paths: {},
      webhooks: {
        noteDue: {
          post: {
            operationId: 'noteDue',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { firedAt: formatted('date-time-local'), quietFrom: formatted('time-local') },
                  },
                },
              },
            },
            responses: { '204': { description: 'No content' } },
          },
        },
      },
    });
    const payload = spec.models.find((model) => model.fields.some((field) => field.name === 'firedAt'));
    expect(payload).toBeDefined();
    expect(createExampleBuilder(spec).forModel(payload!)).toEqual({
      firedAt: '2026-01-15T12:00:00',
      quietFrom: '12:00:00',
    });
  });
});

describe('#734 what a sample is drawn from before the format is asked stays as it was', () => {
  it("returns the document's example or default for a date or time string, as written", async () => {
    const spec = await parse({
      openapi: '3.1.0',
      info: { title: 'Repro', version: '1.0.0' },
      paths: {
        '/notes': {
          get: {
            operationId: 'listNotes',
            parameters: [
              { name: 'paramExample', in: 'query', schema: formatted('time'), example: '08:30:00+01:00' },
              { name: 'schemaExample', in: 'query', schema: formatted('time', { example: '08:31:00+01:00' }) },
              { name: 'schemaExamples', in: 'query', schema: formatted('time', { examples: ['08:32:00+01:00'] }) },
              { name: 'schemaDefault', in: 'query', schema: formatted('time', { default: '09:00:00Z' }) },
              // Not in its format: a document's own value is never adjusted.
              { name: 'offFormat', in: 'query', schema: formatted('time-local', { example: 'noon' }) },
            ],
            responses: { '204': { description: 'No content' } },
          },
        },
      },
      components: {
        schemas: {
          Note: {
            type: 'object',
            properties: {
              withExample: formatted('date-time-local', { example: '1999-12-31T23:59:59' }),
              withExamples: formatted('time-local', { examples: ['23:59:59', '00:00:00'] }),
              withDefault: formatted('time', { default: '09:00:00Z' }),
              withBoth: formatted('http-date', { example: 'Sun, 06 Nov 1994 08:49:37 GMT', default: 'never' }),
              withNeither: formatted('duration'),
            },
          },
        },
      },
    });
    const builder = createExampleBuilder(spec);
    expect(builder.forModel('Note')).toEqual({
      withExample: '1999-12-31T23:59:59',
      withExamples: '23:59:59',
      withDefault: '09:00:00Z',
      withBoth: 'Sun, 06 Nov 1994 08:49:37 GMT',
      withNeither: 'P1D',
    });
    expect(
      onlyOperation(spec).queryParams.map((parameter) => [parameter.name, builder.forParameter(parameter)]),
    ).toEqual([
      ['paramExample', '08:30:00+01:00'],
      ['schemaExample', '08:31:00+01:00'],
      ['schemaExamples', '08:32:00+01:00'],
      ['schemaDefault', '09:00:00Z'],
      ['offFormat', 'noon'],
    ]);
  });

  it('returns the first value of an enum and the value of a const, whatever the format beside them', async () => {
    const spec = await parse({
      openapi: '3.1.0',
      info: { title: 'Repro', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          Note: {
            type: 'object',
            properties: {
              opens: formatted('time', { enum: ['09:00:00Z', '17:00:00Z'] }),
              closes: formatted('time-local', { const: '18:00:00' }),
            },
          },
        },
      },
    });
    expect(createExampleBuilder(spec).forModel('Note')).toEqual({ opens: '09:00:00Z', closes: '18:00:00' });
  });
});

describe('#734 a string the table has no row for keeps the plain sample', () => {
  const builder = createExampleBuilder(emptySpec());

  it('keeps the samples of the other formats the builder knew', () => {
    expect(builder.forType(stringOf('email'))).toBe('user@example.com');
    expect(builder.forType(stringOf('uri'))).toBe('https://example.com');
    expect(builder.forType(stringOf('url'))).toBe('https://example.com');
    expect(builder.forType(stringOf('uuid'))).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('gives a string with no format, or with a format nobody defines, the plain sample', () => {
    expect(builder.forType(stringOf())).toBe(PLAIN);
    expect(builder.forType(stringOf('made-up'))).toBe(PLAIN);
    expect(builder.forType(stringOf(''))).toBe(PLAIN);
  });

  it('reads a format as it is spelled: another case or a padded name is another format', () => {
    for (const format of ['Date-Time-Local', 'TIME', 'Time-Local', ' time', 'time ', 'date_time_local', 'datetime']) {
      expect([format, builder.forType(stringOf(format))]).toEqual([format, PLAIN]);
    }
  });

  it('does not take a member every object has for a row of the table', () => {
    for (const format of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'size', 'get']) {
      expect([format, builder.forType(stringOf(format))]).toEqual([format, PLAIN]);
    }
  });

  it('does not take a format that is not a string for the format it would print as', () => {
    // The parser copies a truthy `format` as it is written, so a malformed one reaches the builder.
    for (const format of [true, 5, ['time'], ['date-time-local'], { time: 'local' }, null]) {
      expect([format, builder.forType(stringOf(format))]).toEqual([format, PLAIN]);
    }
  });

  it('leaves the registry formats that are not a date or a time as they were', () => {
    // #734 is about dates and times; these still get the plain sample.
    for (const format of ['byte', 'binary', 'password', 'hostname', 'ipv4', 'ipv6', 'uri-reference', 'idn-email']) {
      expect([format, builder.forType(stringOf(format))]).toEqual([format, PLAIN]);
    }
  });
});

describe('#734 only a string is given a format sample', () => {
  const builder = createExampleBuilder(emptySpec());
  const primitive = (type: string, format: string): TypeRef => ({ kind: 'primitive', type, format }) as TypeRef;

  it('generates a number with a date or time format as any other number, inside its limits', () => {
    // The registry allows `unixtime` as a number too; `1` is one second past the epoch.
    expect(builder.forType(primitive('integer', 'unixtime'))).toBe(1);
    expect(builder.forType(primitive('number', 'unixtime'))).toBe(1);
    expect(builder.forType(primitive('integer', 'unixtime'), { minimum: 1700000000 })).toBe(1700000000);
    expect(builder.forType(primitive('integer', 'date-time'))).toBe(1);
  });

  it('generates a boolean or an untyped value with a date or time format as before', () => {
    expect(builder.forType(primitive('boolean', 'time'))).toBe(true);
    expect(builder.forType(primitive('unknown', 'time'))).toBeNull();
  });
});

describe('#734 a format sample is returned untouched, as the date-time sample is', () => {
  const builder = createExampleBuilder(emptySpec());

  it('is not padded or truncated to the limits written beside the format', () => {
    for (const format of ['date-time', 'date-time-local', 'time', 'time-local', 'http-date', 'unixtime', 'duration']) {
      const expected = STRING_FORMAT_SAMPLES.get(format);
      expect([format, builder.forType(stringOf(format), { maxLength: 3 })]).toEqual([format, expected]);
      expect([format, builder.forType(stringOf(format), { minLength: 40 })]).toEqual([format, expected]);
      expect([format, builder.forType(stringOf(format), { pattern: '^never$' })]).toEqual([format, expected]);
    }
    // The plain sample still is.
    expect(builder.forType(stringOf('made-up'), { maxLength: 3 })).toBe('str');
  });

  it('is not varied by index under uniqueItems, so a unique array repeats it', () => {
    const unique = { minItems: 2, uniqueItems: true };
    // As a unique array of date-time strings did before #734 and does now.
    expect(builder.forType({ kind: 'array', items: stringOf('date-time') }, unique)).toEqual([
      '2026-01-15T12:00:00.000Z',
      '2026-01-15T12:00:00.000Z',
    ]);
    expect(builder.forType({ kind: 'array', items: stringOf('time') }, unique)).toEqual(['12:00:00Z', '12:00:00Z']);
    // The plain sample still is.
    expect(builder.forType({ kind: 'array', items: stringOf('made-up') }, unique)).toEqual([PLAIN, `${PLAIN}1`]);
  });

  it('is what a field and a parameter built by hand get, too', () => {
    const field: Field = { name: 'remindAt', type: stringOf('date-time-local'), required: false };
    const parameter: Parameter = { name: 'since', type: stringOf('time'), required: false };
    expect(builder.forField(field)).toBe('2026-01-15T12:00:00');
    expect(builder.forParameter(parameter)).toBe('12:00:00Z');
    expect(builder.forField({ ...field, example: 'tomorrow' })).toBe('tomorrow');
    expect(builder.forParameter({ ...parameter, default: 'now' })).toBe('now');
  });
});
