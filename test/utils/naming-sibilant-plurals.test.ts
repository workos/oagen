import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveDataPathFromSchema } from '../../src/parser/responses.js';
import { qualifyInlineModelName } from '../../src/parser/inline-models.js';
import { cleanSchemaName, singularize, singularizePathSegment } from '../../src/utils/naming.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #620: `singularize` — which names an inline array's item model after
 * its field (`qualifyInlineModelName`), a shared error body's nested items
 * (`collapseErrorBodies`), the items a `dataPath` hint ends in
 * (`inlineItemNameForPath`) and a component by its leading word
 * (`cleanSchemaName`) — dropped `es` from every `-ses` word and only `s` from
 * every other `-es` word: `causes` → `PetCaus`, `licenses` → `PetLicens`,
 * `responses` → `PetRespons`, `boxes` → `PetBoxe`, `Licenses` → `Licens`.
 * `singularizePathSegment` already told a sibilant stem (`boxes`, `statuses`)
 * from a plain `s` plural (`causes`, `releases`). Both now share one suffix
 * rule, so a field and a resource of one noun spell its singular alike.
 */

const items = { type: 'array', items: { type: 'object', properties: { note: { type: 'string' } } } };

/** The issue's repro: `GET /pets/{petId}` returning `Pet`, whose arrays are the words under test, beside a component `Licenses`. */
function issueRepro(
  openapi: string,
  fields: string[] = ['boxes', 'causes', 'licenses', 'notes', 'responses', 'statuses'],
) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: { type: 'object', properties: Object.fromEntries(fields.map((field) => [field, items])) },
        Licenses: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  };
}

/** Two operations whose 404 is the inline body `{ message, causes: [{ reason }] }`, which the error-body pass folds onto one shared model. */
function sharedErrorBodyRepro(openapi: string) {
  const errorBody = {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      causes: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' } } } },
    },
  };
  const operation = (operationId: string) => ({
    get: {
      operationId,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        '404': { description: 'nf', content: { 'application/json': { schema: errorBody } } },
      },
    },
  });
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: { '/pets/{id}': operation('getPet'), '/toys/{id}': operation('getToy') },
    components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'string' } } } } },
  };
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

describe('#620', () => {
  describe('singularize reads a -ses / -xes word as singularizePathSegment does', () => {
    it("drops only the `s` of a plain `-s` plural whose stem ends in `se` (the issue's words)", () => {
      expect(singularize('Causes')).toBe('Cause');
      expect(singularize('Licenses')).toBe('License');
      expect(singularize('Responses')).toBe('Response');
      expect(singularize('Releases')).toBe('Release');
      expect(singularize('Cases')).toBe('Case');
      expect(singularize('Databases')).toBe('Database');
      expect(singularize('Warehouses')).toBe('Warehouse');
      expect(singularize('Purchases')).toBe('Purchase');
    });

    it('drops the `es` of a sibilant stem: -sses, consonant + -uses, -iases, -xes, -ches, -shes', () => {
      expect(singularize('Boxes')).toBe('Box');
      expect(singularize('Indexes')).toBe('Index');
      expect(singularize('Matrixes')).toBe('Matrix');
      expect(singularize('Taxes')).toBe('Tax');
      expect(singularize('Batches')).toBe('Batch');
      expect(singularize('Searches')).toBe('Search');
      expect(singularize('Hashes')).toBe('Hash');
      expect(singularize('Pushes')).toBe('Push');
      expect(singularize('Buses')).toBe('Bus');
      expect(singularize('Viruses')).toBe('Virus');
      expect(singularize('Statuses')).toBe('Status');
      expect(singularize('Addresses')).toBe('Address');
      expect(singularize('Processes')).toBe('Process');
      expect(singularize('Classes')).toBe('Class');
      expect(singularize('Aliases')).toBe('Alias');
    });

    it('turns -yses into -ysis, and returns that singular as it is', () => {
      expect(singularize('Analyses')).toBe('Analysis');
      expect(singularize('Analysis')).toBe('Analysis');
      expect(singularize('Paralyses')).toBe('Paralysis');
    });

    it('agrees with singularizePathSegment on every word both read as a plural', () => {
      const words = [
        'causes',
        'licenses',
        'responses',
        'releases',
        'cases',
        'databases',
        'warehouses',
        'boxes',
        'indexes',
        'taxes',
        'batches',
        'searches',
        'hashes',
        'buses',
        'viruses',
        'statuses',
        'addresses',
        'aliases',
        'analyses',
        'directories',
        'policies',
        'organizations',
        'notes',
        'diagnoses',
        'excuses',
        'caches',
        'quizzes',
      ];
      for (const word of words) {
        expect(singularize(capitalize(word)), word).toBe(capitalize(singularizePathSegment(word)));
      }
    });

    it('is applied to a raw field name too, as collapseErrorBodies passes one', () => {
      expect(singularize('causes')).toBe('cause');
      expect(singularize('error_causes')).toBe('error_cause');
      expect(singularize('boxes')).toBe('box');
      expect(singularize('statuses')).toBe('status');
    });

    it('returns every singular it produces as it is when passed back in', () => {
      for (const word of [
        'Causes',
        'Licenses',
        'Responses',
        'Boxes',
        'Batches',
        'Hashes',
        'Analyses',
        'Statuses',
        'Addresses',
        'Aliases',
        'Notes',
        'Directories',
      ]) {
        const once = singularize(word);
        expect(singularize(once), `${word} → ${once}`).toBe(once);
      }
    });
  });

  describe('singularize keeps every reading it had', () => {
    it('keeps the plain plurals and -ies', () => {
      expect(singularize('Notes')).toBe('Note');
      expect(singularize('Users')).toBe('User');
      expect(singularize('Organizations')).toBe('Organization');
      expect(singularize('Directories')).toBe('Directory');
      expect(singularize('Policies')).toBe('Policy');
    });

    it('keeps a safe-listed word and an invariant', () => {
      for (const word of [
        'Status',
        'Address',
        'Access',
        'Process',
        'Progress',
        'Success',
        'Radius',
        'Canvas',
        'Alias',
        'Basis',
        'Bus',
        'Species',
        'Series',
      ]) {
        expect(singularize(word), word).toBe(word);
      }
      expect(singularize('Data')).toBe('Data');
    });

    it('keeps a word of four letters or fewer, and a word ending in ss', () => {
      for (const word of ['Pets', 'Tags', 'Keys', 'Ids', 'Gas', 'News', 'Axes', 'Uses', 'Class', 'Boss']) {
        expect(singularize(word), word).toBe(word);
      }
    });

    it('still reads a -us or -is word as a plural', () => {
      expect(singularize('Menus')).toBe('Menu');
      expect(singularize('Emojis')).toBe('Emoji');
    });
  });

  describe('singularizePathSegment is unchanged', () => {
    it('reads the same words as before', () => {
      expect(singularizePathSegment('causes')).toBe('cause');
      expect(singularizePathSegment('licenses')).toBe('license');
      expect(singularizePathSegment('responses')).toBe('response');
      expect(singularizePathSegment('boxes')).toBe('box');
      expect(singularizePathSegment('statuses')).toBe('status');
      expect(singularizePathSegment('addresses')).toBe('address');
      expect(singularizePathSegment('aliases')).toBe('alias');
      expect(singularizePathSegment('analyses')).toBe('analysis');
      expect(singularizePathSegment('pies')).toBe('pie');
      expect(singularizePathSegment('ANALYSES')).toBe('ANALYSIS');
      expect(singularizePathSegment('DIRECTORIES')).toBe('DIRECTORY');
      expect(singularizePathSegment('status')).toBe('status');
      expect(singularizePathSegment('utopias')).toBe('utopias');
      expect(singularizePathSegment('series')).toBe('series');
      // A documented limit both singularizers share.
      expect(singularizePathSegment('quizzes')).toBe('quizze');
    });
  });

  describe('every caller of singularize', () => {
    it('cleanSchemaName names a component by its singular leading word, idempotently', () => {
      expect(cleanSchemaName('Licenses')).toBe('License');
      expect(cleanSchemaName('LicensesDto')).toBe('LicenseDto');
      expect(cleanSchemaName('ResponsesController')).toBe('Response');
      expect(cleanSchemaName('BoxesListItemState')).toBe('BoxState');
      expect(cleanSchemaName('Causes')).toBe('Cause');
      expect(cleanSchemaName('Analyses')).toBe('Analysis');
      expect(cleanSchemaName('Analysis')).toBe('Analysis');
      expect(cleanSchemaName('Statuses')).toBe('Status');
      for (const name of [
        'Licenses',
        'LicensesDto',
        'ResponsesController',
        'BoxesListItemState',
        'Causes',
        'Analyses',
      ]) {
        const once = cleanSchemaName(name);
        expect(cleanSchemaName(once), `${name} → ${once}`).toBe(once);
      }
    });

    it('qualifyInlineModelName singularizes the trailing word of an array field', () => {
      expect(qualifyInlineModelName('Causes', 'Pet')).toBe('PetCause');
      expect(qualifyInlineModelName('Boxes', 'Pet')).toBe('PetBox');
      expect(qualifyInlineModelName('Licenses', 'Pet')).toBe('PetLicense');
      expect(qualifyInlineModelName('Responses', 'Pet')).toBe('PetResponse');
      expect(qualifyInlineModelName('Statuses', 'Pet')).toBe('PetStatus');
      expect(qualifyInlineModelName('Notes', 'Pet')).toBe('PetNote');
      expect(qualifyInlineModelName('ErrorCauses', 'Pet')).toBe('PetErrorCause');
    });

    it('inlineItemNameForPath names the items a dataPath hint ends in by the singular of its last segment', () => {
      const inlineItems = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } };
      const root: SchemaObject = {
        type: 'object',
        properties: {
          result: { type: 'object', properties: { responses: inlineItems, boxes: inlineItems, items: inlineItems } },
        },
      };
      const names = (dataPath: string) =>
        resolveDataPathFromSchema(root, dataPath, 'ListPetsResponse')?.inlineModels.map((m) => m.name);
      expect(names('result.responses')).toEqual(['ListPetsResultResponse']);
      expect(names('result.boxes')).toEqual(['ListPetsResultBox']);
      expect(names('result.items')).toEqual(['ListPetsResultItem']);
    });
  });

  describe('through the parser', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let tmpDir: string;

    beforeEach(async () => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-620-'));
    });

    afterEach(async () => {
      warn.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function parseJson(doc: unknown): Promise<ApiSpec> {
      const specFile = path.join(tmpDir, 'spec.json');
      await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
      return parseSpec(specFile);
    }

    const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name);

    const expected = ['Pet', 'License', 'PetBox', 'PetCause', 'PetLicense', 'PetNote', 'PetResponse', 'PetStatus'];

    it.each(['3.1.0', '3.0.3'])(
      "names the issue's models License, PetBox, PetCause, PetLicense, PetNote, PetResponse, PetStatus (OAS %s)",
      async (openapi) => {
        const spec = await parseJson(issueRepro(openapi));
        expect(modelNames(spec)).toEqual(expected);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('names them the same whatever order the fields are declared in', async () => {
      const spec = await parseJson(
        issueRepro('3.1.0', ['statuses', 'responses', 'notes', 'licenses', 'causes', 'boxes']),
      );
      expect([...modelNames(spec)].sort()).toEqual([...expected].sort());
    });

    it('types a field that references the component Licenses as the model License', async () => {
      const doc = issueRepro('3.1.0', ['causes']);
      doc.components.schemas.Pet.properties.license = { $ref: '#/components/schemas/Licenses' } as never;
      const spec = await parseJson(doc);
      const pet = spec.models.find((m) => m.name === 'Pet');
      expect(pet?.fields.find((f) => f.name === 'license')?.type).toEqual({ kind: 'model', name: 'License' });
      expect(modelNames(spec)).toEqual(['Pet', 'License', 'PetCause']);
    });

    it.each(['3.1.0', '3.0.3'])(
      "names a shared error body's nested items ErrorBodyCauseWithReason (OAS %s)",
      async (openapi) => {
        const spec = await parseJson(sharedErrorBodyRepro(openapi));
        expect(modelNames(spec)).toEqual(['Pet', 'ErrorBody', 'ErrorBodyCauseWithReason']);
        const body = spec.models.find((m) => m.name === 'ErrorBody');
        expect(body?.fields.find((f) => f.name === 'causes')?.type).toEqual({
          kind: 'array',
          items: { kind: 'model', name: 'ErrorBodyCauseWithReason' },
        });
      },
    );
  });
});
