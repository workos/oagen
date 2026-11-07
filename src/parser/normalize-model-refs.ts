import type { ApiSpec, Callback, TypeRef, Webhook } from '../ir/types.js';
import {
  walkTypeRef,
  callbackContext,
  collectResponseHeaders,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
} from '../ir/types.js';

export function validateModelRefs(spec: ApiSpec): void {
  const knownNames = new Set<string>();
  for (const m of spec.models) knownNames.add(m.name);
  for (const e of spec.enums) knownNames.add(e.name);

  function walkRef(ref: TypeRef, context: string): void {
    walkTypeRef(ref, {
      model: (r) => {
        if (!knownNames.has(r.name)) {
          console.warn(`[oagen] Warning: Unresolved model reference "${r.name}" (context: ${context})`);
        }
      },
    });
  }

  /** A webhook's or a callback's references, and its callbacks' after them, under `<context>.callbacks.<name>.<expression>.<method>` (#382). */
  function walkReceived(node: Webhook, context: string): void {
    for (const p of [...node.headerParams, ...node.queryParams, ...(node.cookieParams ?? [])]) {
      walkRef(p.type, `${context}.${p.name}`);
    }
    if (node.requestBody) walkRef(node.requestBody, `${context}.requestBody`);
    // The payload of every other media type, which shares no reference with `requestBody`.
    for (const content of node.requestBodyContents ?? []) {
      if (content.type !== node.requestBody) {
        walkRef(content.type, `${context}.requestBodyContents.${content.contentType}`);
      }
    }
    walkCallbacks(node, context);
  }

  function walkCallbacks(node: { callbacks?: Callback[] }, context: string): void {
    for (const callback of node.callbacks ?? []) walkReceived(callback, callbackContext(context, callback));
  }

  for (const model of spec.models) {
    for (const field of model.fields) {
      walkRef(field.type, `${model.name}.${field.name}`);
      if (field.inheritedFrom) walkRef(field.inheritedFrom, `${model.name}.${field.name}.inheritedFrom`);
    }
    for (const variant of model.variants ?? []) {
      walkRef(variant, `${model.name}.variants`);
    }
    // The bases a composed component names (`Model.bases`; #591).
    for (const base of model.bases ?? []) {
      walkRef(base, `${model.name}.bases`);
    }
  }

  for (const service of spec.services) {
    for (const op of service.operations) {
      for (const p of [
        ...op.pathParams,
        ...op.queryParams,
        ...(op.bodyOwnedQueryParams ?? []),
        ...op.headerParams,
        ...(op.cookieParams ?? []),
      ]) {
        walkRef(p.type, `${service.name}.${op.name}.${p.name}`);
      }
      if (op.requestBody) walkRef(op.requestBody, `${service.name}.${op.name}.requestBody`);
      walkRef(op.response, `${service.name}.${op.name}.response`);
      // Every other success entry's own type: the primary's is `response`.
      for (const entry of op.successResponses ?? []) {
        walkRef(entry.type, `${service.name}.${op.name}.successResponses.${entry.statusCode}`);
      }
      if (op.pagination) walkRef(op.pagination.itemType, `${service.name}.${op.name}.pagination.itemType`);
      for (const field of op.pagination?.envelopeFields ?? []) {
        walkRef(field.type, `${service.name}.${op.name}.pagination.${field.name}`);
      }
      for (const error of op.errors) {
        if (error.type) walkRef(error.type, `${service.name}.${op.name}.errors.${error.statusCode}`);
      }
      for (const header of collectResponseHeaders(op)) {
        walkRef(header.type, `${service.name}.${op.name}.headers.${header.name}`);
      }
      for (const { type, source } of collectResponseBodyTypes(op)) {
        walkRef(type, `${service.name}.${op.name}.${source}`);
      }
      for (const { type, source } of collectRequestBodyTypes(op)) {
        walkRef(type, `${service.name}.${op.name}.${source}`);
      }
      // A body group's members are typed afresh from the body's variant
      // schemas, so they are references of their own; a query group's are
      // the operation's parameters, walked above.
      for (const group of op.parameterGroups ?? []) {
        for (const variant of group.variants) {
          for (const p of variant.parameters) {
            walkRef(p.type, `${service.name}.${op.name}.parameterGroups.${group.name}.${variant.name}.${p.name}`);
          }
        }
      }
      walkCallbacks(op, `${service.name}.${op.name}`);
    }
  }

  for (const webhook of spec.webhooks ?? []) {
    walkReceived(webhook, `webhooks.${webhook.name}.${webhook.httpMethod}`);
  }
}
