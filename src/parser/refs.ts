import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDocumentFromString, bundleDocument, createConfig, BaseResolver, Oas3_1Types } from '@redocly/openapi-core';
import { SpecParseError } from '../errors.js';
import { schemaRefTokens } from './schema-refs.js';

export interface BundledSpec {
  parsed: Record<string, unknown>;
  specPath: string;
}

export async function loadAndBundleSpec(specPath: string): Promise<BundledSpec> {
  const absolutePath = resolve(specPath);
  const content = await readFile(absolutePath, 'utf-8');
  const document = makeDocumentFromString(content, pathToFileURL(absolutePath).href);
  // The bundler rewrites the document in place, so what it rewrites is
  // recorded first and written back once it is done (see `SchemaMappingTarget`).
  const mappingTargets = recordSchemaMappingTargets(document.parsed);
  const ownSchemaKeys = new Set(Object.keys(componentSchemasOf(document.parsed) ?? {}));

  const config = await createConfig({});
  const resolver = new BaseResolver();

  const result = await bundleDocument({
    document,
    config,
    types: Oas3_1Types,
    externalRefResolver: resolver,
    dereference: false,
  });

  if (result.problems.some((p) => p.severity === 'error')) {
    const errors = result.problems
      .filter((p) => p.severity === 'error')
      .map((p) => p.message)
      .join('\n');
    throw new SpecParseError(
      `Failed to parse spec: ${errors}`,
      `Check the OpenAPI spec at "${absolutePath}" for syntax errors. Run a linter such as \`npx @redocly/cli lint ${specPath}\` to identify issues.`,
    );
  }

  const parsed = result.bundle.parsed as Record<string, unknown>;
  restoreSchemaMappingTargets(parsed, mappingTargets, ownSchemaKeys);
  return { parsed, specPath: absolutePath };
}

/**
 * A discriminator `mapping` entry whose target is a `$ref` into
 * `components/schemas`, as the document spells it (#539, #619). The bundler
 * follows every such target to the schema it stands for — through a
 * component that is an alias (`Hound: { $ref: '#/components/schemas/
 * Shelter/properties/dog' }`; #619 review) — and, when that schema is no
 * component of its own, hoists it into a component named by its pointer's
 * last token (`dog`: the very object `Shelter.dog` is, not a copy, stepped
 * to `dog-2` when a component `dog` of another shape exists) and rewrites
 * the entry to it (`DiscriminatorMapping.leave` in `@redocly/openapi-core`'s
 * bundle visitor): `dog: '#/components/schemas/Shelter/properties/dog'`
 * and `dog: '#/components/schemas/Hound'` alike become `#/components/
 * schemas/dog`, and an alias of a component the component it aliases,
 * while a variant written as the same pointer or alias is left as written.
 * Read so, the entry would name the model built for the component the
 * bundler added (`Dog`), which no variant, field or operation references,
 * instead of the model built for the schema it stands for (`ShelterDog`).
 * So every such entry is recorded before the bundle
 * (`recordSchemaMappingTargets`) and written back after it, the component
 * the bundler added for it dropped (`restoreSchemaMappingTargets`): the
 * parser reads the entry as the document wrote it — as it reads one
 * `transformSpec` writes — and settles it to the model the schema it
 * stands for is built as (`deferPointerMappingEntries`). A target that is
 * a pointer into another section of the document, or into another file,
 * is no schema `$ref` the parser follows, and is left to the bundler.
 */
interface SchemaMappingTarget {
  /** The `mapping` object, which the bundler rewrites in place. */
  mapping: Record<string, unknown>;
  /** The discriminator value the entry is for. */
  value: string;
  /** The target as the document wrote it. */
  target: string;
}

/** Every schema mapping target under `document` (see `SchemaMappingTarget`), before the bundler reads it. */
function recordSchemaMappingTargets(document: unknown): SchemaMappingTarget[] {
  const targets: SchemaMappingTarget[] = [];
  walkObjects(document, (node) => {
    const mapping = isRecord(node.discriminator) ? node.discriminator.mapping : undefined;
    if (!isRecord(mapping)) return;
    for (const [value, target] of Object.entries(mapping)) {
      if (typeof target === 'string' && schemaRefTokens(target) !== undefined) targets.push({ mapping, value, target });
    }
  });
  return targets;
}

/**
 * Write every recorded target the bundler rewrote back as written, and
 * drop each component the bundler added for one — a key `components/
 * schemas` lacked before the bundle (`ownSchemaKeys`) — once nothing in
 * the document names it any more: a `$ref` of the document's own could
 * name no component the document lacked, so only another rewrite the
 * bundler made (one left to it, see `SchemaMappingTarget`) can, and a
 * component so named is kept. A target rewritten to a component the
 * document declares itself — the component an alias stands for, or one
 * the bundler found equal to the schema pointed at — is written back too:
 * the entry names the schema it stands for, not a look-alike, and the
 * parser reads the alias itself.
 */
function restoreSchemaMappingTargets(
  document: Record<string, unknown>,
  targets: readonly SchemaMappingTarget[],
  ownSchemaKeys: ReadonlySet<string>,
): void {
  const added = new Set<string>();
  for (const { mapping, value, target } of targets) {
    const rewritten = mapping[value];
    if (rewritten === target) continue;
    const key = schemaRefTokens(rewritten)?.[0];
    if (key !== undefined && !ownSchemaKeys.has(key)) added.add(key);
    mapping[value] = target;
  }
  if (added.size === 0) return;
  walkObjects(document, (node) => {
    for (const value of Object.values(node)) {
      const key = schemaRefTokens(value)?.[0];
      if (key !== undefined) added.delete(key);
    }
  });
  const schemas = componentSchemasOf(document);
  if (schemas === undefined) return;
  for (const key of added) delete schemas[key];
}

/** The document's `components.schemas` map, when it has one. */
function componentSchemasOf(document: unknown): Record<string, unknown> | undefined {
  if (!isRecord(document) || !isRecord(document.components)) return undefined;
  return isRecord(document.components.schemas) ? document.components.schemas : undefined;
}

/** Call `visit` on every object under `node`, each once: the document is a tree, and a node two aliases share is visited once. */
function walkObjects(
  node: unknown,
  visit: (object: Record<string, unknown>) => void,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkObjects(item, visit, seen);
    return;
  }
  const object = node as Record<string, unknown>;
  visit(object);
  for (const value of Object.values(object)) walkObjects(value, visit, seen);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
