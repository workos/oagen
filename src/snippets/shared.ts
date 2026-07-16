import type { EmitterContext } from '../engine/types.js';
import { ConfigError } from '../errors.js';
import type { ResolvedOperation, ResolvedWrapper } from '../ir/operation-hints.js';
import type { Field, Model, Parameter } from '../ir/types.js';
import { toSnakeCase } from '../utils/naming.js';
import type { ExampleBuilder } from './example-builder.js';

/**
 * One argument resolved for a call-site snippet. The {@link wireName} stays
 * in the spec's casing so each language emitter can apply its own
 * field/param casing rules (snake_case for Python/Ruby/PHP, PascalCase for
 * Go/.NET, etc.).
 *
 * Path and query params carry their {@link Parameter} so emitters can pick
 * language-specific safe names; body args carry their {@link Field} so
 * emitters can read field-level metadata (deprecated, type details).
 */
export interface SnippetArg {
  /** 'path' | 'body' | 'query' — used by emitters to pick a casing rule. */
  source: 'path' | 'body' | 'query';
  /** Spec wire name (e.g. `domain_data`, `client_id`). */
  wireName: string;
  /** Pre-computed illustrative value (string, number, array, object, ...). */
  value: unknown;
  /** Original parameter for path/query args, null for body fields. */
  parameter: Parameter | null;
  /** Original field for body args, null for path/query params. */
  field: Field | null;
}

/**
 * Resolve the set of required arguments for a snippet. Body fields are
 * expanded from the request body model; defaults / inferFromClient fields
 * are filtered out (they're injected by the SDK, not the caller).
 *
 * Iteration order: path params, then required body fields, then required
 * query params. Wire-name collisions between body and path are reported in
 * {@link collisionNames} so the emitter can rename whichever side it
 * prefers (e.g. prefix body field with `body_`).
 */
export interface CollectedArgs {
  args: SnippetArg[];
  /** Body field wire names that also appear as path params. */
  collisionNames: Set<string>;
}

export function collectSnippetArgs(
  resolved: ResolvedOperation,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): CollectedArgs {
  const op = resolved.operation;
  const hidden = hiddenParamSet(resolved);
  const args: SnippetArg[] = [];
  const pathWireNames = new Set<string>();

  for (const p of op.pathParams) {
    if (!p.required) continue;
    if (hidden.has(p.name)) continue;
    pathWireNames.add(p.name);
    args.push({
      source: 'path',
      wireName: p.name,
      value: exampleForParam(p, examples),
      parameter: p,
      field: null,
    });
  }

  const collisionNames = new Set<string>();
  const bodyWireNames = new Set<string>();
  if (op.requestBody?.kind === 'model') {
    const bodyModel = findModel(ctx, op.requestBody.name);
    if (bodyModel) {
      for (const f of bodyModel.fields) {
        if (!f.required || f.deprecated) continue;
        if (hidden.has(f.name)) continue;
        if (pathWireNames.has(f.name)) collisionNames.add(f.name);
        bodyWireNames.add(f.name);
        args.push({
          source: 'body',
          wireName: f.name,
          value: exampleForField(f, examples),
          parameter: null,
          field: f,
        });
      }
    }
  }

  for (const q of op.queryParams) {
    if (!q.required) continue;
    if (hidden.has(q.name)) continue;
    // Some operations (e.g. OAuth-style token endpoints) accept the same field
    // via both the query string and the request body. The IR keeps both for
    // wire-format fidelity, but a call site must pass each argument only once,
    // so skip a query param already emitted as a body field. A query param
    // that merely shares a path param's name is left intact: path args are
    // positional and never share the options object, so there is no clash to
    // resolve (path/body collisions are handled separately via collisionNames).
    if (bodyWireNames.has(q.name)) continue;
    args.push({
      source: 'query',
      wireName: q.name,
      value: exampleForParam(q, examples),
      parameter: q,
      field: null,
    });
  }

  return { args, collisionNames };
}

/**
 * Build the arg list for a single split (wrapper) variant. The wrapper's
 * `exposedParams` is the contract; fields are looked up on the variant model
 * by exact name and then snake-case-normalized name. Optional status comes
 * from `wrapper.optionalParams` first, then from the field's `required` flag.
 */
export function collectWrapperArgs(
  wrapper: ResolvedWrapper,
  ctx: EmitterContext,
  examples: ExampleBuilder,
): SnippetArg[] {
  const exactVariantModel = ctx.spec.models.find((m) => m.name === wrapper.targetVariant);
  // Policies may preserve an SDK acronym such as `MFA` while the parser's
  // canonical IR name uses `Mfa`. Accept a unique case-only difference, but
  // never guess when multiple models collide under case folding.
  const caseInsensitiveMatches = exactVariantModel
    ? []
    : ctx.spec.models.filter((m) => m.name.toLowerCase() === wrapper.targetVariant.toLowerCase());
  const variantModel =
    exactVariantModel ?? (caseInsensitiveMatches.length === 1 ? caseInsensitiveMatches[0] : undefined);
  if (!variantModel) {
    throw new ConfigError(
      `Snippet wrapper "${wrapper.name}" targets unknown model "${wrapper.targetVariant}".`,
      'Set targetVariant to an IR model name after cleanSchemaName/schemaNameTransform has been applied.',
    );
  }

  const variantFields = variantModel.fields;
  const optionalSet = new Set(wrapper.optionalParams);
  const args: SnippetArg[] = [];

  for (const paramName of wrapper.exposedParams) {
    const field =
      variantFields.find((f) => f.name === paramName || toSnakeCase(f.name) === toSnakeCase(paramName)) ?? null;
    const isOptional = optionalSet.has(paramName) ? true : field ? !field.required : false;
    if (isOptional) continue;
    if (!field) {
      throw new ConfigError(
        `Snippet wrapper "${wrapper.name}" exposes unknown field "${paramName}" on model "${variantModel.name}".`,
        'Remove the field from exposedParams or update it to match a field on the targetVariant model.',
      );
    }
    args.push({
      source: 'body',
      wireName: paramName,
      value: examples.forField(field),
      parameter: null,
      field,
    });
  }

  return args;
}

export function hiddenParamSet(resolved: ResolvedOperation): Set<string> {
  const hidden = new Set<string>();
  for (const k of Object.keys(resolved.defaults)) hidden.add(k);
  for (const k of resolved.inferFromClient) hidden.add(k);
  return hidden;
}

function findModel(ctx: EmitterContext, name: string): Model | undefined {
  return ctx.spec.models.find((m) => m.name === name);
}

function exampleForParam(p: Parameter, examples: ExampleBuilder): unknown {
  if (p.example !== undefined) return p.example;
  if (p.default !== undefined) return p.default;
  return examples.forType(p.type);
}

function exampleForField(f: Field, examples: ExampleBuilder): unknown {
  return examples.forField(f);
}
