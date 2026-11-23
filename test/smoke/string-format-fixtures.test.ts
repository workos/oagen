import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { STRING_FORMAT_SAMPLES } from '../../src/snippets/example-builder.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import {
  generateCamelPayload,
  generateCamelQueryParams,
  generateFixtureValue,
  generatePayload,
  generateQueryParams,
} from '../../scripts/smoke/shared.js';

/**
 * Issue #734, at the sibling site: the smoke payloads map a string's
 * `format` to a fixture as the snippet example builder maps it to a sample,
 * and knew the same five formats. A required `date-time-local`, `time-local`
 * or `time` string was sent as `test_<field name>`, which the API rejects.
 * The fixtures now know every format the builder knows, the date and time
 * ones written as the instant of the smoke `date-time` fixture.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function parse(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-734-smoke-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const emptySpec: ApiSpec = {
  name: 'TestApi',
  version: '1.0.0',
  baseUrl: 'https://api.test.com',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

const stringOf = (format?: unknown): TypeRef =>
  ({ kind: 'primitive', type: 'string', ...(format === undefined ? {} : { format }) }) as TypeRef;
const fixture = (format?: unknown) => generateFixtureValue(stringOf(format), 'remindAt', emptySpec);
/** What a string without a known format is sent as. */
const NAMED = 'test_remind_at';

const formatted = (format: string) => ({ type: 'string', format });

describe('#734 smoke fixtures: every date and time string format has a fixture', () => {
  it.each([
    // The two the fixtures knew before #734, unchanged.
    ['date-time', '2024-01-01T00:00:00Z'],
    ['date', '2024-01-01'],
    // The three the issue reports.
    ['date-time-local', '2024-01-01T00:00:00'],
    ['time-local', '00:00:00'],
    ['time', '00:00:00Z'],
    // The registry's other date and time formats for a string.
    ['http-date', 'Mon, 01 Jan 2024 00:00:00 GMT'],
    ['unixtime', '1704067200'],
    ['duration', 'P1D'],
  ])('%s: %s', (format, expected) => {
    expect(fixture(format)).toBe(expected);
  });

  it('writes one instant, the one of the date-time fixture, in every format that names an instant', () => {
    const dateTime = fixture('date-time') as string;
    const instant = new Date(dateTime);
    const iso = instant.toISOString();
    const fullDate = iso.slice(0, 10);
    const timeToSeconds = iso.slice(11, 19);
    expect(dateTime).toBe(`${fullDate}T${timeToSeconds}Z`);
    expect(fixture('date')).toBe(fullDate);
    expect(fixture('date-time-local')).toBe(`${fullDate}T${timeToSeconds}`);
    expect(fixture('time-local')).toBe(timeToSeconds);
    expect(fixture('time')).toBe(`${timeToSeconds}Z`);
    expect(fixture('http-date')).toBe(instant.toUTCString());
    expect(fixture('unixtime')).toBe(String(instant.getTime() / 1000));
  });

  it('knows every format the snippet example builder knows', () => {
    for (const format of STRING_FORMAT_SAMPLES.keys()) {
      expect([format, fixture(format) === NAMED]).toEqual([format, false]);
    }
  });

  it('keeps the fixtures of the other formats it knew', () => {
    expect(fixture('uuid')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(fixture('email')).toBe('test@example.com');
    expect(fixture('uri')).toBe('https://example.com');
    expect(fixture('url')).toBe('https://example.com');
  });

  it('names a string after its field when it has no format or one without a fixture', () => {
    for (const format of [undefined, 'made-up', 'Date-Time-Local', 'TIME', 'byte', 'password', 'hostname']) {
      expect([format, fixture(format)]).toEqual([format, NAMED]);
    }
    // A member every object has is not a row of the table, nor is a format that is not a string.
    for (const format of ['constructor', 'toString', '__proto__', 'size', true, 5, ['time'], null]) {
      expect([format, fixture(format)]).toEqual([format, NAMED]);
    }
  });

  it('generates a number with a date or time format as any other number', () => {
    const integer = { kind: 'primitive', type: 'integer', format: 'unixtime' } as TypeRef;
    expect(generateFixtureValue(integer, 'expiresAt', emptySpec)).toBe(1);
  });
});

describe.each(['3.1.0', '3.0.3'])(
  '#734 smoke payloads send a date or time string in its format (OAS %s)',
  (openapi) => {
    const document = () => ({
      openapi,
      info: { title: 'Repro', version: '1.0.0' },
      paths: {
        '/notes': {
          post: {
            operationId: 'createNote',
            parameters: [
              { name: 'since', in: 'query', required: true, schema: formatted('time') },
              { name: 'valid_until', in: 'query', required: true, schema: formatted('date-time-local') },
              { name: 'window', in: 'query', required: true, schema: formatted('duration') },
              // Not required: not sent.
              { name: 'until', in: 'query', schema: formatted('time-local') },
            ],
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } },
            responses: { '204': { description: 'No content' } },
          },
        },
      },
      components: {
        schemas: {
          Note: {
            type: 'object',
            required: ['createdAt', 'dueOn', 'remindAt', 'remindTime', 'sentTime', 'modified', 'ttl', 'stamp', 'slots'],
            properties: {
              createdAt: formatted('date-time'),
              dueOn: formatted('date'),
              remindAt: formatted('date-time-local'),
              remindTime: formatted('time-local'),
              sentTime: formatted('time'),
              modified: formatted('http-date'),
              ttl: formatted('duration'),
              stamp: formatted('unixtime'),
              slots: { type: 'array', items: formatted('time-local') },
              // Not required: not sent.
              optionalTime: formatted('time'),
            },
          },
        },
      },
    });
    const operationOf = (spec: ApiSpec): Operation => spec.services.flatMap((service) => service.operations)[0]!;

    it('in the raw request body and query', async () => {
      const spec = await parse(document());
      const operation = operationOf(spec);
      expect(generatePayload(operation, spec)).toEqual({
        created_at: '2024-01-01T00:00:00Z',
        due_on: '2024-01-01',
        remind_at: '2024-01-01T00:00:00',
        remind_time: '00:00:00',
        sent_time: '00:00:00Z',
        modified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        ttl: 'P1D',
        stamp: '1704067200',
        slots: ['00:00:00'],
      });
      expect(generateQueryParams(operation, spec)).toEqual({
        since: '00:00:00Z',
        valid_until: '2024-01-01T00:00:00',
        window: 'P1D',
      });
    });

    it('in the SDK call arguments, where only a date-time becomes a Date, as before', async () => {
      const spec = await parse(document());
      const operation = operationOf(spec);
      expect(generateCamelPayload(operation, spec)).toEqual({
        createdAt: new Date('2024-01-01T00:00:00Z'),
        dueOn: '2024-01-01',
        remindAt: '2024-01-01T00:00:00',
        remindTime: '00:00:00',
        sentTime: '00:00:00Z',
        modified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        ttl: 'P1D',
        stamp: '1704067200',
        slots: ['00:00:00'],
      });
      expect(generateCamelQueryParams(operation, spec)).toEqual({
        since: '00:00:00Z',
        validUntil: '2024-01-01T00:00:00',
        window: 'P1D',
      });
    });
  },
);
