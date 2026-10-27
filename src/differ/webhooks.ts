import type { Webhook } from '../ir/types.js';
import type { Change, ParamChange, RequestBodyContentTypesChange } from './types.js';
import { jsonEncodedOnBothSides, locatedParams, paramKey, parameterContentTypeShift } from './params.js';
import {
  deprecationDetails,
  deprecationFlip,
  parameterNameShift,
  requestBodyEncodingDetails,
  requestBodyEncodingShift,
  tagsShift,
  type RequestBodyEncodingShift,
} from './classify.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';
import { classifySecurityChange, securityShift, type DocumentSecurity } from './security.js';
import { diffRequestBodyContentTypes, ownRepresentationKept } from './media-types.js';
import type { DocumentShapes } from './shapes.js';

/**
 * Report webhooks added, removed and modified between two specs. A webhook is
 * keyed by `name` + `httpMethod` (one `webhooks` key may declare several
 * methods), so a method change is a removal plus an addition.
 * `documentSecurity` — the two documents' `security` — lets a webhook that
 * declares none of its own be compared on what it inherits; `diffSpecs`
 * passes it, a direct caller may leave it out.
 */
export function diffWebhooks(
  oldWebhooks: Webhook[],
  newWebhooks: Webhook[],
  documentSecurity?: DocumentSecurity,
  shapes?: DocumentShapes,
): Change[] {
  const changes: Change[] = [];
  const key = (webhook: Webhook): string => `${webhook.httpMethod} ${webhook.name}`;
  const oldByKey = new Map(oldWebhooks.map((w) => [key(w), w]));
  const newByKey = new Map(newWebhooks.map((w) => [key(w), w]));

  for (const [k, webhook] of newByKey) {
    if (!oldByKey.has(k)) {
      changes.push({
        kind: 'webhook-added',
        name: webhook.name,
        httpMethod: webhook.httpMethod,
        classification: 'additive',
      });
    }
  }

  for (const [k, webhook] of oldByKey) {
    if (!newByKey.has(k)) {
      changes.push({
        kind: 'webhook-removed',
        name: webhook.name,
        httpMethod: webhook.httpMethod,
        classification: 'breaking',
      });
    }
  }

  for (const [k, newWebhook] of newByKey) {
    const oldWebhook = oldByKey.get(k);
    if (!oldWebhook) continue;

    const paramChanges = diffWebhookParams(oldWebhook, newWebhook);
    const body = diffWebhookBody(oldWebhook, newWebhook, shapes);
    const responses = diffWebhookResponses(oldWebhook, newWebhook);
    // Additive either way: the handler's signature is unchanged, but a
    // changelog has to say it, so a flipped flag alone is a change.
    const deprecation = deprecationFlip(oldWebhook, newWebhook);
    const deprecatedChanged = deprecation !== undefined;
    // What the request carries, `webhook.security ?? document security` on
    // each side, resolved as an operation's is; read from the receiver's
    // side, so what the sender may now present must still carry what the
    // handler checked for.
    const security = securityShift(oldWebhook, newWebhook, documentSecurity);
    const securityChanged = security !== undefined;
    const securityBreaking =
      security !== undefined &&
      classifySecurityChange(security.oldSecurity, security.newSecurity, 'receiver') === 'breaking';
    // Additive always, as on an operation.
    const tags = tagsShift(oldWebhook, newWebhook);
    const tagsChanged = tags !== undefined;
    if (
      paramChanges.length === 0 &&
      body.changes.length === 0 &&
      responses.changes.length === 0 &&
      !deprecatedChanged &&
      !securityChanged &&
      !tagsChanged
    ) {
      continue;
    }

    const hasBreaking =
      body.breaking ||
      responses.breaking ||
      securityBreaking ||
      paramChanges.some((pc) => pc.classification === 'breaking');
    const details = [...body.changes, ...responses.changes];
    changes.push({
      kind: 'webhook-modified',
      name: newWebhook.name,
      httpMethod: newWebhook.httpMethod,
      paramChanges,
      requestBodyChanged: body.changes.length > 0,
      ...body.encoding,
      ...(body.mediaTypes ? { requestBodyContentTypeChange: body.mediaTypes } : {}),
      responsesChanged: responses.changes.length > 0,
      deprecatedChanged,
      ...deprecation,
      securityChanged,
      ...security,
      tagsChanged,
      ...tags,
      ...(details.length > 0 ? { details: details.join('; ') } : {}),
      classification: hasBreaking ? 'breaking' : 'additive',
    });
  }

  return changes;
}

/**
 * Compare what the handler is handed as a body, from the receiver's side:
 *
 * - type changed, gained or lost: breaking — it is the handler's parameter type.
 * - encoding changed: breaking when the representation the sender now uses
 *   — the media type the new payload is read from, with its shape — is not
 *   one the old spec declared with that shape (compared as a retype is,
 *   `sameShape` through `shapes`), so the handler decodes a wire format it
 *   never saw; additive when the old spec already declared it (a media type
 *   dropped beside a kept one). A payload without media-type lists reads as
 *   breaking. Read through `requestBodyEncodingShift`, the function
 *   `diffOperations` reads an operation's body encoding with — so, as on an
 *   operation, compared only while both sides carry a payload: one
 *   appearing or disappearing takes its encoding with it and is `payload
 *   added` / `payload removed` alone — and carried as `encoding` beside the
 *   `details` string so the change can report both sides.
 * - required → optional: breaking — a handler that assumed a body may get none.
 * - optional → required: additive — the body is now always there.
 *   The flag is compared only while both sides carry a payload
 *   (`requestBody`), as on an operation, so one appearing or disappearing
 *   takes its flag with it. The parser also sets the flag on a body it reads
 *   no payload from (one under `application/xml` alone, say); that flag is
 *   not compared either.
 * - media types changed, both sides declaring a payload: one the sender can
 *   newly use, or whose body changed type, is breaking — the handler must
 *   decode it; one it can no longer use, or one that only changed a
 *   parameter other than `charset`, is additive. Compared by essence as an
 *   operation's are (`diffRequestBodyContentTypes`), and carried structured
 *   as `mediaTypes` beside the `details` strings.
 */
function diffWebhookBody(
  oldWebhook: Webhook,
  newWebhook: Webhook,
  shapes?: DocumentShapes,
): {
  changes: string[];
  breaking: boolean;
  encoding?: RequestBodyEncodingShift;
  mediaTypes?: RequestBodyContentTypesChange;
} {
  const changes: string[] = [];
  let breaking = false;

  const oldBody = oldWebhook.requestBody;
  const newBody = newWebhook.requestBody;
  const sameType = oldBody && newBody ? typeRefsEqual(oldBody, newBody) : !oldBody && !newBody;
  if (!sameType) {
    changes.push(!oldBody ? 'payload added' : !newBody ? 'payload removed' : 'payload type changed');
    breaking = true;
  }

  const encoding = requestBodyEncodingShift(oldWebhook, newWebhook);
  if (encoding) {
    changes.push(requestBodyEncodingDetails(encoding));
    // From the receiver's side: what the sender now sends must be a
    // representation the old handler already decoded. The sides stay in
    // old → new order, with `shapes`, so the documents are read the right
    // way round; `side` picks whose body must survive.
    if (!ownRepresentationKept(oldWebhook, newWebhook, 'receiver', shapes)) breaking = true;
  }

  const wasRequired = oldWebhook.requestBodyRequired === true;
  const isRequired = newWebhook.requestBodyRequired === true;
  if (oldBody && newBody && wasRequired !== isRequired) {
    changes.push(isRequired ? 'body optional → required' : 'body required → optional');
    if (!isRequired) breaking = true;
  }

  const mediaTypes = diffRequestBodyContentTypes(oldWebhook, newWebhook, 'receiver', shapes);
  if (mediaTypes) {
    const said = (what: string, list: string[]): string[] =>
      list.length > 0 ? [`payload media type${list.length > 1 ? 's' : ''} ${list.join(', ')} ${what}`] : [];
    changes.push(...said('added', mediaTypes.added), ...said('removed', mediaTypes.removed));
    changes.push(...said('retyped', mediaTypes.retyped));
    changes.push(...mediaTypes.reparameterized.map(({ from, to }) => `payload media type ${from} → ${to}`));
    if (mediaTypes.classification === 'breaking') breaking = true;
  }

  return { changes, breaking, ...(encoding ? { encoding } : {}), ...(mediaTypes ? { mediaTypes } : {}) };
}

/**
 * Compare the status codes the sender accepts from the receiver. A code no
 * longer accepted is breaking — a handler that keeps returning it now fails
 * the delivery — and a newly accepted one is additive. Descriptions are not
 * compared, as nowhere else in the differ.
 */
function diffWebhookResponses(oldWebhook: Webhook, newWebhook: Webhook): { changes: string[]; breaking: boolean } {
  const oldCodes = new Set(oldWebhook.responses.map((r) => r.statusCode));
  const newCodes = new Set(newWebhook.responses.map((r) => r.statusCode));
  const removed = [...oldCodes].filter((code) => !newCodes.has(code));
  const added = [...newCodes].filter((code) => !oldCodes.has(code));
  const changes: string[] = [];
  if (removed.length > 0) changes.push(`accepted response ${removed.join(', ')} removed`);
  if (added.length > 0) changes.push(`accepted response ${added.join(', ')} added`);
  return { changes, breaking: removed.length > 0 };
}

/**
 * Diff a webhook's parameters in every location it carries them — header,
 * query and cookie, through the `locatedParams` walk an operation's
 * `diffParams` uses too — from the receiver's side, which inverts the
 * request-side rules `classifyParamChange` applies to an operation: the
 * receiver reads these values and never supplies them. Parameters are
 * matched by location and name (`paramKey`, a header's name case-folded),
 * since OpenAPI lets a header and a query parameter share a name, and every
 * change carries its `paramLocation`.
 *
 * - added: additive, required or not — the sender simply starts carrying it.
 * - name changed: only a header's case can (`X-Pet-Signature` →
 *   `x-pet-signature`); additive, as on an operation — the wire reads it
 *   the same (RFC 9110 §5.1).
 * - removed: breaking — handler code that read it has nothing to read.
 * - type changed: breaking; format-only changes are additive, as elsewhere.
 * - optional → required: additive (now always present);
 *   required → optional: breaking (code that assumed presence breaks).
 * - default changed: additive with details, as the receiver sets no defaults;
 *   kept visible because it may still change what the receiver observes.
 * - deprecated flipped: additive either way, as on an operation's parameter —
 *   the value is still carried with the same type and requiredness.
 */
function diffWebhookParams(oldWebhook: Webhook, newWebhook: Webhook): ParamChange[] {
  const changes: ParamChange[] = [];
  const oldByKey = new Map(locatedParams(oldWebhook).map((e) => [paramKey(e.loc, e.p.name), e]));
  const newByKey = new Map(locatedParams(newWebhook).map((e) => [paramKey(e.loc, e.p.name), e]));

  for (const [k, { p, loc }] of newByKey) {
    if (!oldByKey.has(k)) {
      changes.push({ kind: 'param-added', paramName: p.name, classification: 'additive', paramLocation: loc });
    }
  }

  for (const [k, { p, loc }] of oldByKey) {
    if (!newByKey.has(k)) {
      changes.push({ kind: 'param-removed', paramName: p.name, classification: 'breaking', paramLocation: loc });
    }
  }

  for (const [k, { p: newParam, loc }] of newByKey) {
    const oldEntry = oldByKey.get(k);
    if (!oldEntry) continue;
    const oldParam = oldEntry.p;
    const name = newParam.name;

    const renamed = parameterNameShift(oldParam, newParam);
    if (renamed) {
      changes.push({
        kind: 'param-name-changed',
        paramName: name,
        classification: 'additive',
        paramLocation: loc,
        ...renamed,
      });
    }

    if (!typeRefsEqual(oldParam.type, newParam.type)) {
      if (primitivesDifferOnlyByFormat(oldParam.type, newParam.type)) {
        changes.push({
          kind: 'param-format-changed',
          paramName: name,
          classification: 'additive',
          paramLocation: loc,
          details: formatChangeDetails(oldParam.type, newParam.type),
        });
      } else {
        changes.push({ kind: 'param-type-changed', paramName: name, classification: 'breaking', paramLocation: loc });
      }
    }

    // The media type the value is serialized in (`Parameter.contentType`,
    // or the one an unread `content` map declares) moved: the handler
    // decodes the value the sender now encodes another way, so breaking from
    // the receiver's side too, like a type change — unless both sides are
    // read from a JSON media type, which the handler decodes alike.
    const reencoded = parameterContentTypeShift(oldParam, newParam);
    if (reencoded) {
      changes.push({
        kind: 'param-content-type-changed',
        paramName: name,
        classification: jsonEncodedOnBothSides(oldParam, newParam) ? 'additive' : 'breaking',
        paramLocation: loc,
        ...reencoded,
      });
    }

    if (oldParam.required !== newParam.required) {
      changes.push({
        kind: 'param-required-changed',
        paramName: name,
        classification: newParam.required ? 'additive' : 'breaking',
        paramLocation: loc,
        details: newParam.required ? 'optional → required' : 'required → optional',
      });
    }

    const oldDefault = serializeDefault(oldParam.default);
    const newDefault = serializeDefault(newParam.default);
    if (oldDefault !== newDefault) {
      changes.push({
        kind: 'param-default-changed',
        paramName: name,
        classification: 'additive',
        oldDefault,
        newDefault,
        paramLocation: loc,
        details: `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`,
      });
    }

    const deprecation = deprecationFlip(oldParam, newParam);
    if (deprecation) {
      changes.push({
        kind: 'param-deprecated-changed',
        paramName: name,
        classification: 'additive',
        paramLocation: loc,
        ...deprecation,
        details: deprecationDetails(deprecation.newDeprecated),
      });
    }
  }

  return changes;
}

function serializeDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
