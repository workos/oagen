import type { Extensions } from '../ir/types.js';
import type { SchemaObject } from './schemas.js';

/**
 * The Schema Object extensions the parser reads into typed IR fields, so
 * they are not repeated in a model's, field's or enum's `extensions`:
 * `x-enum-descriptions` / `x-enumDescriptions` give each enum value its
 * `description` (`enumValueDescriptions` in `schemas.ts`).
 */
export const SCHEMA_CONSUMED_EXTENSIONS: ReadonlySet<string> = new Set(['x-enum-descriptions', 'x-enumDescriptions']);

/**
 * The Operation Object extensions the parser reads into typed fields, so
 * they are not repeated in an operation's `extensions`: `x-pagination`
 * (`pagination`, through `resolvePaginationOverride`), `x-oagen-async`
 * (`async`), `x-mutually-exclusive-parameter-groups` and
 * `x-mutually-exclusive-body-groups` (`parameterGroups`).
 */
export const OPERATION_CONSUMED_EXTENSIONS: ReadonlySet<string> = new Set([
  'x-pagination',
  'x-oagen-async',
  'x-mutually-exclusive-parameter-groups',
  'x-mutually-exclusive-body-groups',
]);

const NONE_CONSUMED: ReadonlySet<string> = new Set();

/**
 * The specification extensions `source` declares — every own key that
 * starts with `x-`, in document order, each with its value exactly as
 * written (an object or array value is the document's own, not a copy) —
 * less the keys in `consumed`, which the parser reads into typed fields
 * elsewhere. `undefined` when none remains, so an IR node built from the
 * result has no `extensions` key at all rather than an empty object.
 */
export function extensionsOf(source: object, consumed: ReadonlySet<string> = NONE_CONSUMED): Extensions | undefined {
  let out: Extensions | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('x-') || consumed.has(key)) continue;
    (out ??= {})[key] = value;
  }
  return out;
}

/**
 * `{ extensions }` when a Schema Object declares at least one extension the
 * parser does not consume (`SCHEMA_CONSUMED_EXTENSIONS`), `{}` otherwise —
 * spread into a `Model`, `Field` or `Enum` literal so the key stays absent
 * rather than present-but-undefined, as `constraintsEntry` and
 * `deprecatedEntry` are.
 */
export function schemaExtensionsEntry(schema: SchemaObject): { extensions?: Extensions } {
  const extensions = extensionsOf(schema, SCHEMA_CONSUMED_EXTENSIONS);
  return extensions ? { extensions } : {};
}

/**
 * `{ extensions }` when an Operation Object declares at least one extension
 * the parser does not consume (`OPERATION_CONSUMED_EXTENSIONS`), `{}`
 * otherwise — spread into the `Operation` literal.
 */
export function operationExtensionsEntry(op: object): { extensions?: Extensions } {
  const extensions = extensionsOf(op, OPERATION_CONSUMED_EXTENSIONS);
  return extensions ? { extensions } : {};
}
