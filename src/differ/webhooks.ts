import type { Parameter, Webhook } from '../ir/types.js';
import type { Change, ParamChange } from './types.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';

/**
 * Report webhooks added, removed and modified between two specs. A webhook is
 * keyed by `name` + `httpMethod` (one `webhooks` key may declare several
 * methods), so a method change is a removal plus an addition.
 */
export function diffWebhooks(oldWebhooks: Webhook[], newWebhooks: Webhook[]): Change[] {
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
    const requestBodyChanged = !requestBodiesEqual(oldWebhook, newWebhook);
    if (paramChanges.length === 0 && !requestBodyChanged) continue;

    // The payload type is the handler's parameter type, so any change to it —
    // including gaining or losing a body — changes the handler's signature.
    const hasBreaking = requestBodyChanged || paramChanges.some((pc) => pc.classification === 'breaking');
    changes.push({
      kind: 'webhook-modified',
      name: newWebhook.name,
      httpMethod: newWebhook.httpMethod,
      paramChanges,
      requestBodyChanged,
      classification: hasBreaking ? 'breaking' : 'additive',
    });
  }

  return changes;
}

function requestBodiesEqual(a: Webhook, b: Webhook): boolean {
  if (!a.requestBody && !b.requestBody) return true;
  if (!a.requestBody || !b.requestBody) return false;
  return typeRefsEqual(a.requestBody, b.requestBody);
}

/**
 * Diff a webhook's header, query and cookie parameters from the receiver's
 * side, which inverts the request-side rules `classifyParamChange` applies
 * to an operation: the receiver reads these values and never supplies them.
 *
 * - added: additive, required or not — the sender simply starts carrying it.
 * - removed: breaking — handler code that read it has nothing to read.
 * - type changed: breaking; format-only changes are additive, as elsewhere.
 * - optional → required: additive (now always present);
 *   required → optional: breaking (code that assumed presence breaks).
 * - default changed: additive with details, as the receiver sets no defaults;
 *   kept visible because it may still change what the receiver observes.
 */
function diffWebhookParams(oldWebhook: Webhook, newWebhook: Webhook): ParamChange[] {
  const changes: ParamChange[] = [];
  const oldByName = new Map(allParams(oldWebhook).map((p) => [p.name, p]));
  const newByName = new Map(allParams(newWebhook).map((p) => [p.name, p]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) changes.push({ kind: 'param-added', paramName: name, classification: 'additive' });
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) changes.push({ kind: 'param-removed', paramName: name, classification: 'breaking' });
  }

  for (const [name, newParam] of newByName) {
    const oldParam = oldByName.get(name);
    if (!oldParam) continue;

    if (!typeRefsEqual(oldParam.type, newParam.type)) {
      if (primitivesDifferOnlyByFormat(oldParam.type, newParam.type)) {
        changes.push({
          kind: 'param-format-changed',
          paramName: name,
          classification: 'additive',
          details: formatChangeDetails(oldParam.type, newParam.type),
        });
      } else {
        changes.push({ kind: 'param-type-changed', paramName: name, classification: 'breaking' });
      }
    }

    if (oldParam.required !== newParam.required) {
      changes.push({
        kind: 'param-required-changed',
        paramName: name,
        classification: newParam.required ? 'additive' : 'breaking',
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
        details: `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`,
      });
    }
  }

  return changes;
}

function allParams(webhook: Webhook): Parameter[] {
  return [...webhook.headerParams, ...webhook.queryParams, ...(webhook.cookieParams ?? [])];
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
