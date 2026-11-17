import { describe, it, expect } from 'vitest';
import { qualifyInlineModelName } from '../../src/parser/inline-models.js';
import { cleanSchemaName, singularize, singularizeTrailingWord, toPascalCase } from '../../src/utils/naming.js';

// #665: `singularize` looked a word up in its safe list as written, and the
// list holds PascalCase words, so a lowercase `canvases` or `series` — what
// `collapseErrorBodies` handed it, the field name as the document spells it —
// fell through to the suffix rules (`canvase`, `sery`). The word is now read
// in lowercase and returned in the case it was given, and the sites that name
// an array's items hand it one word, the trailing word of the field's
// PascalCased name (`singularizeTrailingWord`).

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Every safe-listed word. */
const SAFE = [
  'status',
  'address',
  'access',
  'process',
  'progress',
  'success',
  'radius',
  'canvas',
  'alias',
  'basis',
  'bus',
  'species',
  'series',
];

describe('#665 singularize reads a word whatever its case', () => {
  it("keeps the issue's words: canvases → canvas, radiuses → radius, series → series", () => {
    expect(singularize('canvases')).toBe('canvas');
    expect(singularize('radiuses')).toBe('radius');
    expect(singularize('series')).toBe('series');
    // As the PascalCase spellings always were.
    expect(singularize('Canvases')).toBe('Canvas');
    expect(singularize('Radiuses')).toBe('Radius');
    expect(singularize('Series')).toBe('Series');
  });

  it.each(SAFE)('keeps the safe-listed %s in lowercase, PascalCase and capitals', (word) => {
    expect(singularize(word)).toBe(word);
    expect(singularize(capitalize(word))).toBe(capitalize(word));
    expect(singularize(word.toUpperCase())).toBe(word.toUpperCase());
  });

  it.each(SAFE)('reads the -es plural of the safe-listed %s as that word, in the case it is given', (word) => {
    expect(singularize(`${word}es`)).toBe(word);
    expect(singularize(`${capitalize(word)}es`)).toBe(capitalize(word));
    expect(singularize(`${word.toUpperCase()}ES`)).toBe(word.toUpperCase());
  });

  it('reads every word alike in lowercase, PascalCase and capitals', () => {
    const words = [
      // Safe-listed words and their plurals.
      'canvases',
      'radiuses',
      'statuses',
      'addresses',
      'aliases',
      'buses',
      'series',
      'species',
      'status',
      'basis',
      // The suffix rules.
      'causes',
      'licenses',
      'responses',
      'boxes',
      'batches',
      'hashes',
      'caches',
      'coaches',
      'directories',
      'policies',
      'analyses',
      'organizations',
      'notes',
      'menus',
      'emojis',
      'bonuses',
      'campus',
      // What is never read as a plural: four letters or fewer, -ss, -ysis, no -s.
      'pets',
      'tags',
      'news',
      'axes',
      'class',
      'boss',
      'analysis',
      'data',
    ];
    for (const word of words) {
      const pascal = singularize(capitalize(word));
      expect(singularize(word), word).toBe(pascal.toLowerCase());
      expect(singularize(word.toUpperCase()), word.toUpperCase()).toBe(pascal.toUpperCase());
    }
  });

  it('returns a word in capitals in capitals', () => {
    expect(singularize('CANVASES')).toBe('CANVAS');
    expect(singularize('SERIES')).toBe('SERIES');
    expect(singularize('CAUSES')).toBe('CAUSE');
    expect(singularize('DIRECTORIES')).toBe('DIRECTORY');
    expect(singularize('ANALYSES')).toBe('ANALYSIS');
    expect(singularize('ANALYSIS')).toBe('ANALYSIS');
    expect(singularize('CLASS')).toBe('CLASS');
    expect(singularize('TAGS')).toBe('TAGS');
  });

  it('reads one word: a name of several is read by its suffix alone, which is why a caller hands it the trailing word', () => {
    expect(singularize('TaxSeries')).toBe('TaxSery');
    expect(singularize('tax_series')).toBe('tax_sery');
    expect(singularize('OrderStatus')).toBe('OrderStatu');
    expect(singularize('ItemTags')).toBe('ItemTag');
    expect(singularizeTrailingWord('TaxSeries')).toBe('TaxSeries');
    expect(singularizeTrailingWord('OrderStatus')).toBe('OrderStatus');
    expect(singularizeTrailingWord('ItemTags')).toBe('ItemTags');
  });
});

describe("#665 singularizeTrailingWord singularizes the trailing word of a field's PascalCased name", () => {
  it.each([
    // One word.
    ['Canvases', 'Canvas'],
    ['Radiuses', 'Radius'],
    ['Series', 'Series'],
    ['Status', 'Status'],
    ['Causes', 'Cause'],
    ['Domains', 'Domain'],
    ['Tags', 'Tags'],
    // The trailing word of several: safe-listed, short, or read by the suffix rules.
    ['TaxSeries', 'TaxSeries'],
    ['OrderStatus', 'OrderStatus'],
    ['ErrorCanvases', 'ErrorCanvas'],
    ['ShippingAddresses', 'ShippingAddress'],
    ['ItemTags', 'ItemTags'],
    ['InvalidKeys', 'InvalidKeys'],
    ['ErrorCauses', 'ErrorCause'],
    ['SSOConnections', 'SSOConnection'],
    ['V2Causes', 'V2Cause'],
    // No trailing word to read: a digit ends the name, or it is empty.
    ['Causes2', 'Causes2'],
    ['CausesV2', 'CausesV2'],
    ['', ''],
    // A trailing capital alone is a word of one letter.
    ['UserSSO', 'UserSSO'],
  ])('%s → %s', (name, expected) => {
    expect(singularizeTrailingWord(name)).toBe(expected);
  });

  it.each([
    ['canvases', 'Canvas'],
    ['CANVASES', 'Canvas'],
    ['tax_series', 'TaxSeries'],
    ['tax-series', 'TaxSeries'],
    ['taxSeries', 'TaxSeries'],
    ['TAX_SERIES', 'TaxSeries'],
    ['shipping_addresses', 'ShippingAddress'],
    ['order_status', 'OrderStatus'],
    ['causes[]', 'Cause'],
  ])('reads the field %s as %s once PascalCased', (field, expected) => {
    expect(singularizeTrailingWord(toPascalCase(field))).toBe(expected);
  });

  it('reads a PascalCased name: one that was never cased has no trailing word and is returned as it is', () => {
    expect(singularizeTrailingWord('causes')).toBe('causes');
    expect(singularizeTrailingWord('tax_series')).toBe('tax_series');
    expect(singularizeTrailingWord(toPascalCase('causes'))).toBe('Cause');
  });

  it('is the reading qualifyInlineModelName names a field under its parent by', () => {
    for (const name of ['Canvases', 'TaxSeries', 'OrderStatus', 'ErrorCanvases', 'ItemTags', 'Causes2', 'Domains']) {
      expect(qualifyInlineModelName(name, 'Pet'), name).toBe(`Pet${singularizeTrailingWord(name)}`);
    }
    expect(qualifyInlineModelName('TaxSeries', 'Pet')).toBe('PetTaxSeries');
    expect(qualifyInlineModelName('Causes2', 'Pet')).toBe('PetCauses2');
    expect(qualifyInlineModelName('Domains', 'ConnectionListItem')).toBe('ConnectionDomain');
    // A field that extends its parent's name stands as it is, as before.
    expect(qualifyInlineModelName('PetOwners', 'Pet')).toBe('PetOwners');
  });

  it('leaves the leading word to cleanSchemaName, which reads it as before', () => {
    expect(cleanSchemaName('Canvases')).toBe('Canvas');
    expect(cleanSchemaName('CanvasesList')).toBe('CanvasList');
    expect(cleanSchemaName('SeriesList')).toBe('SeriesList');
    expect(cleanSchemaName('StatusList')).toBe('StatusList');
  });
});
