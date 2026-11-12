import { isDeepStrictEqual } from 'node:util';
import type { Extensions, Operation } from '../ir/types.js';
import type { ConstraintsShift } from './constraints.js';
import type { ModelDirection } from './direction.js';
import type { FieldChange, ParamChange, RequestBodyEncoding, ResponseHeaderChange } from './types.js';

/**
 * How a limits change on a model's site — a field, the model's own
 * keywords, a named union's variant — is classified (#599): breaking when
 * a keyword was tightened (`constraintsShift(...).tightened`) and the model
 * is request-facing, both-facing or of unknown direction, since a value a
 * caller sends today can be rejected; additive on a response-only model,
 * where the SDK only reads the value and nothing it compiles against
 * moves, as a required `field-added` is softened there, and additive when
 * every keyword only loosened, from either side, since the wire base type
 * is unchanged, as for `field-format-changed`.
 */
export function classifyConstraintsChange(tightened: boolean, direction: ModelDirection): 'additive' | 'breaking' {
  return tightened && direction !== 'response' ? 'breaking' : 'additive';
}

/**
 * The `details` a limits change on a model's site carries: the shift's own
 * (every keyword that moved, old → new), followed by `; tightened on a
 * response-only model` when the direction is what made a tightened keyword
 * additive (`classifyConstraintsChange`), as a required `field-added` says
 * `required on a response-only model`.
 */
export function constraintsDetails(
  shift: Pick<ConstraintsShift, 'details' | 'tightened'>,
  direction: ModelDirection,
): string {
  return shift.tightened && direction === 'response'
    ? `${shift.details}; tightened on a response-only model`
    : shift.details;
}

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

/** The two sides of a parameter's name, carried on the `param-name-changed` entry that reports it. */
export interface ParameterNameShift {
  /** The name as the old spec wrote it (`X-Pet-Token`). */
  oldName: string;
  /** The name as the new spec writes it (`x-pet-token`). */
  newName: string;
  /** `name X-Pet-Token → x-pet-token`. */
  details: string;
}

/**
 * `{ oldName, newName, details }` when two parameters the differ paired
 * are not written the same, `undefined` when they are. Parameters are
 * paired on `parameterKey`, which folds a header's name and nothing else,
 * so the only pairing whose two names differ is a header whose name
 * changed case alone (`X-Pet-Token` → `x-pet-token`): the same header on
 * the wire (RFC 9110 §5.1), still accepted with the same type and
 * requiredness, hence additive at the IR layer — an emitter that derives an
 * identifier from the name as written may still rename it, which its own
 * compat check reports, as it does for `param-format-changed` (#295).
 * A response header pairs on `foldHeaderName` the same way, so its
 * respelling is read through this function too (`header-name-changed`).
 */
export function parameterNameShift(
  oldParam: { name: string },
  newParam: { name: string },
): ParameterNameShift | undefined {
  if (oldParam.name === newParam.name) return undefined;
  return {
    oldName: oldParam.name,
    newName: newParam.name,
    details: `name ${oldParam.name} → ${newParam.name}`,
  };
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

/** The two sides of an `extensions` change, carried on the change that reports it; each side present only when the node had extensions there. */
export interface ExtensionsShift {
  oldExtensions?: Extensions;
  newExtensions?: Extensions;
}

/** A node's `extensions` as compared: an absent key and an empty object both read as none. */
function declaredExtensions(node: { extensions?: Extensions }): Extensions | undefined {
  const { extensions } = node;
  return extensions !== undefined && Object.keys(extensions).length > 0 ? extensions : undefined;
}

/**
 * `{ oldExtensions?, newExtensions? }` when a node's `extensions` differ
 * between the two specs — a key added, removed or given another value,
 * compared deeply (`isDeepStrictEqual`), key order aside — `undefined` when
 * they do not. An absent key and an empty object are the same thing: the
 * parser leaves the key absent when a node declares no extension. The
 * differ spreads the result onto the owning change, as it does a
 * deprecation flip, so the `behaviorChanges` mirror never looks the node up
 * again; a side the node had no extensions on is left absent.
 */
export function extensionsShift(
  oldNode: { extensions?: Extensions },
  newNode: { extensions?: Extensions },
): ExtensionsShift | undefined {
  const oldExtensions = declaredExtensions(oldNode);
  const newExtensions = declaredExtensions(newNode);
  if (isDeepStrictEqual(oldExtensions, newExtensions)) return undefined;
  return {
    ...(oldExtensions ? { oldExtensions } : {}),
    ...(newExtensions ? { newExtensions } : {}),
  };
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
 * `requestBodyEncoding` differs between the two specs while both carry a
 * `requestBody`, `undefined` otherwise. The encoding is the wire format the
 * body is serialized as (`json`, `form-data`, `form-urlencoded`, `binary`,
 * `text`), read from the media type the body is declared under. A body
 * appearing or disappearing takes its encoding with it and is the body
 * change's to report (`requestBodyChanged` on an operation, `payload added`
 * / `payload removed` on a webhook), so neither change kind carries the two
 * sides for it. An absent encoding beside a body is compared as a value of
 * its own, so a body that gained or lost one is a change too. Whether a
 * change breaks is the caller's rule — `diffOperations` and
 * `diffWebhookBody` read it off the media types each side declares
 * (`ownRepresentationKept`): an SDK built for the old spec keeps sending
 * the old representation, and a handler built for it keeps decoding what
 * it declared. Both read the encoding through this function, so an
 * operation's body and a webhook's payload are judged alike.
 */
export function requestBodyEncodingShift(
  oldNode: { requestBody?: Operation['requestBody']; requestBodyEncoding?: RequestBodyEncoding },
  newNode: { requestBody?: Operation['requestBody']; requestBodyEncoding?: RequestBodyEncoding },
): RequestBodyEncodingShift | undefined {
  if (!oldNode.requestBody || !newNode.requestBody) return undefined;
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

/** The fields of an operation or a webhook that say whether it carries a request body. */
export type RequestBodyCarrier = Pick<Operation, 'requestBody' | 'requestBodyContentTypes'>;

/**
 * Whether a node's `requestBodyRequired` is compared between the two specs:
 * true while both sides carry a body the parser keeps the flag on — one
 * read as `requestBody`, or one carried in `requestBodyContents` alone,
 * whose media types (`requestBodyContentTypes`) are declared but none of
 * them read (#474), a body under `application/xml` or `application/*+json`
 * alone, say. An SDK that offers such a body through its contents makes
 * the argument mandatory when the flag is `true`, so a flip on it is
 * reported exactly as one on a body read as `requestBody` is (#528),
 * whichever way each side is read: an old document's body carried in its
 * contents and the new document's read as `requestBody`, with the flag on
 * both, is compared too. A body appearing or disappearing, on either
 * reading, takes its flag with it, as it takes its encoding
 * (`requestBodyEncodingShift`): on one that is read as `requestBody` the
 * body change is reported in its place, on one carried in its contents
 * alone nothing is. An absent flag on a carried body reads as optional, as
 * it does in OpenAPI; a webhook's is only ever `true`, so its absence
 * never says the payload is gone. `diffOperations` and `diffWebhookBody`
 * both read the flag through this function, so an operation's body and a
 * webhook's payload are judged alike.
 */
export function requestBodyRequiredCompared(oldNode: RequestBodyCarrier, newNode: RequestBodyCarrier): boolean {
  return carriesRequestBody(oldNode) && carriesRequestBody(newNode);
}

/** A body read as `requestBody`, or one carried in `requestBodyContents` alone (`requestBodyContentTypes` set). */
function carriesRequestBody(node: RequestBodyCarrier): boolean {
  return node.requestBody !== undefined || node.requestBodyContentTypes !== undefined;
}

/**
 * Classify a change to a model's or a list envelope's field. `flag` is read
 * by three kinds: `field-added` and `field-required-changed` take the new
 * side's `required`, and `field-constraints-changed` takes whether a limit
 * was tightened (`constraintsShift(...).tightened`). `direction` — which
 * side of the wire the owning model is used on — softens `field-added` and
 * `field-constraints-changed` on a response-only model; it defaults to
 * `unknown`, which keeps the conservative direction-blind classification
 * for callers that have no model-usage index to hand.
 */
export function classifyFieldChange(
  kind: FieldChange['kind'],
  fieldName: string,
  flag?: boolean,
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
      if (flag && direction === 'response') {
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
        classification: flag ? 'breaking' : 'additive',
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
        classification: flag ? 'breaking' : 'additive',
        details: flag ? 'optional → required' : 'required → optional',
      };
    case 'field-access-changed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-deprecated-changed':
      // Deprecation changes no contract: the field is still there with the
      // same type and requiredness, whichever way the flag went. The caller
      // attaches `details` saying which way (see `deprecationDetails`).
      return { kind, fieldName, classification: 'additive' };
    case 'field-extensions-changed':
      // Extensions are not shape: the field is still there with the same
      // type and requiredness. The caller spreads the two sides on
      // (`extensionsShift`).
      return { kind, fieldName, classification: 'additive' };
    case 'field-constraints-changed':
      // A limit tightened (`flag`) rejects a value the old document
      // accepted, so it is breaking wherever a caller constructs the value —
      // a request-facing, both-facing or unknown-direction model — and
      // additive on a response-only model, where the SDK only reads the
      // value and nothing it compiles against moves, as a required
      // `field-added` is softened. A limit loosened is additive from either
      // side: the wire base type is unchanged, as for
      // `field-format-changed` (#599; `classifyConstraintsChange`). The
      // caller attaches the two sides and `details` (`constraintsShift`).
      return { kind, fieldName, classification: classifyConstraintsChange(flag === true, direction) };
  }
}

/**
 * Classify a change to a header a response declares, from the reader's side:
 * the SDK reads the header off the response and never sends it, so the rules
 * are the ones `diffWebhookParams` applies to a webhook's parameters, not
 * `classifyParamChange`'s request-side ones.
 *
 * - added: additive, required or not — the server simply starts sending it.
 * - removed: breaking — an accessor the SDK exposed has nothing to read.
 * - type changed: breaking; format-only changes are additive, as elsewhere.
 * - optional → required: additive (now always present);
 *   required → optional: breaking (code that assumed presence breaks).
 * - name respelled (case only, since that is all a pair can differ by):
 *   additive — an emitter may derive an identifier from the name as written.
 * - deprecated flipped: additive either way — the header is still sent with
 *   the same type and requiredness.
 * - limits changed: additive either way — the SDK reads the value and never
 *   sends it, so nothing it compiles against moves (#599).
 *
 * `isRequired` is read for `header-required-changed` only: the new side's
 * flag. The caller attaches the `details` and sides the kind carries.
 */
export function classifyResponseHeaderChange(
  kind: ResponseHeaderChange['kind'],
  headerName: string,
  isRequired?: boolean,
): ResponseHeaderChange {
  switch (kind) {
    case 'header-added':
      return { kind, headerName, classification: 'additive' };
    case 'header-removed':
      return { kind, headerName, classification: 'breaking' };
    case 'header-type-changed':
      return { kind, headerName, classification: 'breaking' };
    case 'header-format-changed':
      return { kind, headerName, classification: 'additive' };
    case 'header-required-changed':
      return {
        kind,
        headerName,
        classification: isRequired ? 'additive' : 'breaking',
        details: isRequired ? 'optional → required' : 'required → optional',
      };
    case 'header-name-changed':
      return { kind, headerName, classification: 'additive' };
    case 'header-deprecated-changed':
      return { kind, headerName, classification: 'additive' };
    case 'header-constraints-changed':
      // The SDK reads the header and never sends it, so a limit tightened or
      // loosened changes nothing it compiles against: additive either way,
      // as a format change is (#599). The caller attaches the two sides and
      // `details` (`constraintsShift`).
      return { kind, headerName, classification: 'additive' };
  }
}

/**
 * Classify a change to an operation's parameter, from the caller's side.
 * `flag` is read by four kinds: `param-added` and `param-required-changed`
 * take the new side's `required`, `param-content-type-changed` takes
 * whether both sides are read from a JSON media type
 * (`jsonEncodedOnBothSides` in `params.ts`), and
 * `param-constraints-changed` whether a limit was tightened
 * (`constraintsShift(...).tightened`).
 */
export function classifyParamChange(kind: ParamChange['kind'], paramName: string, flag?: boolean): ParamChange {
  switch (kind) {
    case 'param-added':
      return {
        kind,
        paramName,
        classification: flag ? 'breaking' : 'additive',
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
        classification: flag ? 'breaking' : 'additive',
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
    case 'param-name-changed':
      // See `parameterNameShift`: only a header's case can differ between
      // two paired parameters, and the wire reads it the same, so this is
      // additive at the IR layer like `param-format-changed`.
      return { kind, paramName, classification: 'additive' };
    case 'param-content-type-changed':
      // See `parameterContentTypeShift`: the media type decides how the value
      // is serialized (JSON-encoded under `application/json`, by style and
      // explode under `schema`, as written under a map the parser does not
      // read), so a caller encoding it the old way sends a value the API no
      // longer reads — breaking in both directions, like a type change.
      // Between two JSON media types the parser reads (`flag`), the value is
      // JSON-encoded either way and nothing a caller sends changes: additive.
      return { kind, paramName, classification: flag ? 'additive' : 'breaking' };
    case 'param-constraints-changed':
      // The caller sends the value: a limit tightened (`flag`) rejects a
      // value the old document accepted, so it is breaking; one loosened is
      // additive, as a format change is (#599). The caller attaches the two
      // sides and `details` (`constraintsShift`).
      return { kind, paramName, classification: flag ? 'breaking' : 'additive' };
  }
}
