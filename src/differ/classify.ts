import type { ModelDirection } from './direction.js';
import type { FieldChange, ParamChange, RequestBodyEncoding } from './types.js';

/**
 * Whether an IR node is deprecated. The parser only ever writes `true` and
 * leaves the key absent otherwise, so `undefined` and an explicit `false` are
 * the same thing here: not deprecated.
 */
export function isDeprecated(node: { deprecated?: boolean }): boolean {
  return node.deprecated === true;
}

/** The `details` of a `*-deprecated-changed` entry, read old → new. */
export function deprecationDetails(nowDeprecated: boolean): string {
  return nowDeprecated ? 'live → deprecated' : 'deprecated → live';
}

/** The two sides of a `deprecated` flip, carried on the change that reports it. */
export interface DeprecationFlip {
  oldDeprecated: boolean;
  newDeprecated: boolean;
}

/**
 * `{ oldDeprecated, newDeprecated }` when the flag differs between the two
 * nodes, `undefined` when it does not. The differ spreads it onto the owning
 * change, so the direction travels with the change and the `behaviorChanges`
 * mirror never has to look the node up again.
 */
export function deprecationFlip(
  oldNode: { deprecated?: boolean },
  newNode: { deprecated?: boolean },
): DeprecationFlip | undefined {
  const oldDeprecated = isDeprecated(oldNode);
  const newDeprecated = isDeprecated(newNode);
  return oldDeprecated === newDeprecated ? undefined : { oldDeprecated, newDeprecated };
}

/** The two sides of a `tags` change, carried on the change that reports it. */
export interface TagsShift {
  /** The node's `tags` in the old spec, in document order; `[]` when it carried none. */
  oldTags: string[];
  /** The node's `tags` in the new spec, in document order; `[]` when it carries none. */
  newTags: string[];
}

/**
 * `{ oldTags, newTags }` when a node's `tags` differ between the two specs,
 * `undefined` when they do not. The lists are compared in document order,
 * entry by entry, since the first tag is what the parser names an
 * operation's service from; an absent key is an empty list.
 */
export function tagsShift(oldNode: { tags?: string[] }, newNode: { tags?: string[] }): TagsShift | undefined {
  const oldTags = oldNode.tags ?? [];
  const newTags = newNode.tags ?? [];
  const same = oldTags.length === newTags.length && oldTags.every((tag, i) => tag === newTags[i]);
  return same ? undefined : { oldTags, newTags };
}

/** The two sides of a `requestBodyEncoding` change, carried on the change that reports it. */
export interface RequestBodyEncodingShift {
  /** The node's `requestBodyEncoding` in the old spec; `undefined` when its body carried none. */
  oldRequestBodyEncoding: RequestBodyEncoding | undefined;
  /** The node's `requestBodyEncoding` in the new spec; `undefined` when its body carries none. */
  newRequestBodyEncoding: RequestBodyEncoding | undefined;
}

/**
 * `{ oldRequestBodyEncoding, newRequestBodyEncoding }` when a node's
 * `requestBodyEncoding` differs between the two specs, `undefined` when it
 * does not. The encoding is the wire format the body is serialized as
 * (`json`, `form-data`, `form-urlencoded`, `binary`, `text`), read from the
 * media type the body is declared under, so a change breaks either side of
 * the wire: an SDK built for the old spec keeps sending the old format, and
 * a handler built for it keeps decoding it. An absent encoding is compared
 * as a value of its own, so a body that gained or lost one is a change too;
 * whether to compare at all when one side carries no body is the caller's
 * rule. `diffOperations` and `diffWebhooks` both read the encoding through
 * this function, so an operation's body and a webhook's payload are judged
 * alike.
 */
export function requestBodyEncodingShift(
  oldNode: { requestBodyEncoding?: RequestBodyEncoding },
  newNode: { requestBodyEncoding?: RequestBodyEncoding },
): RequestBodyEncodingShift | undefined {
  const oldRequestBodyEncoding = oldNode.requestBodyEncoding;
  const newRequestBodyEncoding = newNode.requestBodyEncoding;
  return oldRequestBodyEncoding === newRequestBodyEncoding
    ? undefined
    : { oldRequestBodyEncoding, newRequestBodyEncoding };
}

/** The `details` a webhook change reports an encoding shift with: `encoding json → form-urlencoded`, `<none>` for no encoding. */
export function requestBodyEncodingDetails(shift: RequestBodyEncodingShift): string {
  return `encoding ${shift.oldRequestBodyEncoding ?? '<none>'} → ${shift.newRequestBodyEncoding ?? '<none>'}`;
}

export function classifyFieldChange(
  kind: FieldChange['kind'],
  fieldName: string,
  isRequired?: boolean,
  // Which side of the wire the owning model is used on. Defaults to `unknown`,
  // which keeps the conservative direction-blind classification for callers that
  // have no model-usage index to hand.
  direction: ModelDirection = 'unknown',
): FieldChange {
  switch (kind) {
    case 'field-added':
      // Requiredness binds callers on the request side only: they must supply
      // every required request field, but they only *read* responses. So a new
      // required field on a response-only model is additive — the server simply
      // always sends it, and existing caller code keeps compiling and
      // deserializing. Request-facing, both-facing, and unknown-direction models
      // keep the breaking classification.
      if (isRequired && direction === 'response') {
        return {
          kind,
          fieldName,
          classification: 'additive',
          details: 'required on a response-only model',
        };
      }
      return {
        kind,
        fieldName,
        classification: isRequired ? 'breaking' : 'additive',
      };
    case 'field-removed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-type-changed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-format-changed':
      // A primitive's `format` changing (e.g., string → string format=email)
      // is classified additive at the IR level: the wire-format base type is
      // unchanged, so callers' deserialization keeps working. Per-emitter
      // compat checks catch any source-level break a specific language layers
      // on top (e.g., a typed Email value object in TypeScript).
      return { kind, fieldName, classification: 'additive' };
    case 'field-required-changed':
      return {
        kind,
        fieldName,
        classification: isRequired ? 'breaking' : 'additive',
        details: isRequired ? 'optional → required' : 'required → optional',
      };
    case 'field-access-changed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-deprecated-changed':
      // Deprecation changes no contract: the field is still there with the
      // same type and requiredness, whichever way the flag went. The caller
      // attaches `details` saying which way (see `deprecationDetails`).
      return { kind, fieldName, classification: 'additive' };
  }
}

export function classifyParamChange(kind: ParamChange['kind'], paramName: string, isRequired?: boolean): ParamChange {
  switch (kind) {
    case 'param-added':
      return {
        kind,
        paramName,
        classification: isRequired ? 'breaking' : 'additive',
      };
    case 'param-removed':
      return { kind, paramName, classification: 'breaking' };
    case 'param-type-changed':
      return { kind, paramName, classification: 'breaking' };
    case 'param-format-changed':
      // See `field-format-changed`: format-only diffs are additive at the IR
      // layer.
      return { kind, paramName, classification: 'additive' };
    case 'param-required-changed':
      return {
        kind,
        paramName,
        classification: isRequired ? 'breaking' : 'additive',
      };
    case 'param-default-changed':
      // Removing or changing a default that callers may have implicitly relied on
      // changes runtime behavior for clients who never set the param explicitly.
      // We treat this as breaking so it surfaces as a major bump rather than
      // sliding through as a silent regression.
      return { kind, paramName, classification: 'breaking' };
    case 'param-deprecated-changed':
      // See `field-deprecated-changed`: the parameter is still accepted with
      // the same type and requiredness, so this is additive either way.
      return { kind, paramName, classification: 'additive' };
  }
}
