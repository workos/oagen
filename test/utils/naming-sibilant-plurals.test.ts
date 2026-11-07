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

    it('keeps the `e` of a consonant + -aches noun, and drops the `es` of a vowel + -aches one', () => {
      expect(singularize('Caches')).toBe('Cache');
      expect(singularize('Headaches')).toBe('Headache');
      expect(singularize('Mustaches')).toBe('Mustache');
      expect(singularize('Coaches')).toBe('Coach');
      expect(singularize('Beaches')).toBe('Beach');
      expect(singularize('Approaches')).toBe('Approach');
      expect(singularizePathSegment('caches')).toBe('cache');
      expect(singularizePathSegment('headaches')).toBe('headache');
      expect(singularizePathSegment('coaches')).toBe('coach');
    });

    it("keeps a safe-listed word's -es plural as that word, whatever the suffix rules would make of it", () => {
      expect(singularize('Canvases')).toBe('Canvas');
      expect(singularize('Radiuses')).toBe('Radius');
      expect(singularize('Statuses')).toBe('Status');
      expect(singularize('Addresses')).toBe('Address');
      expect(singularize('Accesses')).toBe('Access');
      expect(singularize('Processes')).toBe('Process');
      expect(singularize('Buses')).toBe('Bus');
      expect(singularize('Aliases')).toBe('Alias');
      // The guard is the safe list's, which a path segment has no part in.
      expect(singularizePathSegment('canvases')).toBe('canvase');
      expect(singularizePathSegment('radiuses')).toBe('radiuse');
    });

    it("reads the suffix rules' documented limits as singularizePathSegment does", () => {
      // `main` happened to read these right: `-ases` with a `-as` stem and
      // `-nses` with a `-ns` stem through its `-ses` branch, `-che` nouns
      // through its plain `s` branch. The shared rules cannot tell them from
      // `cases`, `licenses` and `branches`, so they read as a path segment.
      expect(singularize('Gases')).toBe('Gase');
      expect(singularize('Lenses')).toBe('Lense');
      expect(singularize('Atlases')).toBe('Atlase');
      expect(singularize('Niches')).toBe('Nich');
      expect(singularize('Cliches')).toBe('Clich');
      expect(singularize('Avalanches')).toBe('Avalanch');
      expect(singularize('Tranches')).toBe('Tranch');
      for (const word of ['gases', 'lenses', 'atlases', 'niches', 'cliches', 'avalanches', 'tranches']) {
        expect(singularize(capitalize(word)), word).toBe(capitalize(singularizePathSegment(word)));
      }
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
        'headaches',
        'coaches',
        'quizzes',
        'bonuses',
        'campuses',
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

    it('returns every singular the suffix rules write as it is when passed back in, but the -us of a consonant + -uses plural', () => {
      for (const word of [
        'Causes',
        'Licenses',
        'Responses',
        'Boxes',
        'Batches',
        'Hashes',
        'Caches',
        'Analyses',
        'Statuses',
        'Addresses',
        'Aliases',
        'Canvases',
        'Radiuses',
        'Notes',
        'Directories',
      ]) {
        const once = singularize(word);
        expect(singularize(once), `${word} → ${once}`).toBe(once);
      }
      // The documented exception, as on every version before: a `-us` word
      // is read as a plural, so the singular a consonant + `-uses` plural
      // gives is not a fixed point unless it is safe-listed (`Statuses`,
      // `Buses`, `Radiuses` above).
      expect(singularize('Bonuses')).toBe('Bonus');
      expect(singularize('Bonus')).toBe('Bonu');
      expect(singularize('Campuses')).toBe('Campus');
      expect(singularize('Campus')).toBe('Campu');
      expect(singularize('Viruses')).toBe('Virus');
      expect(singularize('Virus')).toBe('Viru');
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

  describe('singularizePathSegment reads every word as before, but a consonant + -aches', () => {
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
      // Documented limits both singularizers share.
      expect(singularizePathSegment('quizzes')).toBe('quizze');
      expect(singularizePathSegment('niches')).toBe('nich');
      expect(singularizePathSegment('avalanches')).toBe('avalanch');
      expect(singularizePathSegment('gases')).toBe('gase');
      expect(singularizePathSegment('lenses')).toBe('lense');
      expect(singularizePathSegment('atlases')).toBe('atlase');
      // The one reading that moved: an `-ache` noun keeps its `e` (`cach` before).
      expect(singularizePathSegment('caches')).toBe('cache');
      expect(singularizePathSegment('headaches')).toBe('headache');
      expect(singularizePathSegment('branches')).toBe('branch');
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
      expect(cleanSchemaName('Caches')).toBe('Cache');
      expect(cleanSchemaName('Canvases')).toBe('Canvas');
      for (const name of [
        'Licenses',
        'LicensesDto',
        'ResponsesController',
        'BoxesListItemState',
        'Causes',
        'Analyses',
        'Caches',
        'Canvases',
      ]) {
        const once = cleanSchemaName(name);
        expect(cleanSchemaName(once), `${name} → ${once}`).toBe(once);
      }
      // The documented exception to its idempotency, as on every version before.
      expect(cleanSchemaName('Bonuses')).toBe('Bonus');
      expect(cleanSchemaName('Bonus')).toBe('Bonu');
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

    // MichaelDeBoey's review of #632: words `main` read right by accident.
    it.each(['3.1.0', '3.0.3'])(
      'keeps Cache and Canvas (PetCache, PetCanvas), and reads gases, lenses and atlases as a path segment (OAS %s)',
      async (openapi) => {
        const doc = issueRepro(openapi, ['caches', 'canvases', 'gases', 'lenses', 'atlases']);
        const schemas = doc.components.schemas as Record<string, unknown>;
        delete schemas.Licenses;
        schemas.Caches = { type: 'object', properties: { id: { type: 'string' } } };
        schemas.Canvases = { type: 'object', properties: { id: { type: 'string' } } };
        const spec = await parseJson(doc);
        expect(modelNames(spec)).toEqual([
          'Pet',
          'Cache',
          'Canvas',
          'PetCache',
          'PetCanvas',
          'PetGase',
          'PetLense',
          'PetAtlase',
        ]);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    // MichaelDeBoey's review of #632: cleanSchemaName also names a body from
    // an operationId and from a components/responses key.
    it.each(['3.1.0', '3.0.3'])(
      'names an inline body from operationId casesCreate CaseCreateRequest/Response and from a component response Boxes BoxResponse (OAS %s)',
      async (openapi) => {
        const body = { type: 'object', properties: { id: { type: 'string' } } };
        const spec = await parseJson({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {
            '/notes': {
              post: {
                operationId: 'casesCreate',
                requestBody: { content: { 'application/json': { schema: body } } },
                responses: { '200': { description: 'ok', content: { 'application/json': { schema: body } } } },
              },
            },
            '/boxes': {
              get: { operationId: 'listBoxes', responses: { '200': { $ref: '#/components/responses/Boxes' } } },
            },
          },
          components: {
            responses: {
              Boxes: {
                description: 'boxes',
                content: {
                  'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } },
                },
              },
            },
          },
        });
        expect(modelNames(spec)).toEqual(['CaseCreateResponse', 'CaseCreateRequest', 'BoxResponse']);
        const operations = spec.services.flatMap((service) => service.operations);
        const casesCreate = operations.find((op) => op.name === 'casesCreate');
        expect(casesCreate?.requestBody).toEqual({ kind: 'model', name: 'CaseCreateRequest' });
        expect(casesCreate?.response).toEqual({ kind: 'model', name: 'CaseCreateResponse' });
        expect(operations.find((op) => op.name === 'listBoxes')?.response).toEqual({
          kind: 'model',
          name: 'BoxResponse',
        });
        expect(warn).not.toHaveBeenCalled();
      },
    );
  });
});
