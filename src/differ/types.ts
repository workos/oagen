export interface DiffReport {
  oldVersion: string;
  newVersion: string;
  changes: Change[];
  /**
   * Cross-cutting events that change observable runtime behavior for callers
   * who did not previously set the affected parameter explicitly. Surfaced
   * separately so PR-description tooling can flag them as breaking even when
   * the type signatures of the operation are otherwise unchanged.
   */
  behaviorChanges: BehaviorChange[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    breaking: number;
    additive: number;
    behaviorChanges: number;
  };
}

export interface BehaviorChange {
  kind: 'param-default-changed';
  /** Service name (e.g. 'authorization', 'accounts'). */
  serviceName: string;
  /** Operation name within the service. */
  operationName: string;
  /** Parameter name (e.g. 'order', 'limit'). */
  paramName: string;
  /** Where the parameter lives; kept in step with `ParamChange.paramLocation`. */
  paramLocation: 'path' | 'query' | 'header' | 'cookie';
  /** Old default value as a string, or null if previously unset. */
  oldDefault: string | null;
  /** New default value as a string, or null if now unset. */
  newDefault: string | null;
  classification: 'breaking';
}

export type Change =
  | ModelAdded
  | ModelRemoved
  | ModelModified
  | EnumAdded
  | EnumRemoved
  | EnumModified
  | ServiceAdded
  | ServiceRemoved
  | OperationAdded
  | OperationRemoved
  | OperationModified
  | WebhookAdded
  | WebhookRemoved
  | WebhookModified;

export interface ModelAdded {
  kind: 'model-added';
  name: string;
  classification: 'additive';
}

export interface ModelRemoved {
  kind: 'model-removed';
  name: string;
  classification: 'breaking';
}

export interface ModelModified {
  kind: 'model-modified';
  name: string;
  fieldChanges: FieldChange[];
  classification: 'additive' | 'breaking';
}

export interface FieldChange {
  kind:
    | 'field-added'
    | 'field-removed'
    | 'field-type-changed'
    | 'field-format-changed'
    | 'field-required-changed'
    | 'field-access-changed';
  fieldName: string;
  classification: 'additive' | 'breaking';
  details?: string;
}

export interface EnumAdded {
  kind: 'enum-added';
  name: string;
  classification: 'additive';
}

export interface EnumRemoved {
  kind: 'enum-removed';
  name: string;
  classification: 'breaking';
}

export interface EnumModified {
  kind: 'enum-modified';
  name: string;
  valueChanges: EnumValueChange[];
  classification: 'additive' | 'breaking';
}

export interface EnumValueChange {
  kind: 'value-added' | 'value-removed' | 'value-changed';
  valueName: string;
  classification: 'additive' | 'breaking';
  details?: string;
}

export interface ServiceAdded {
  kind: 'service-added';
  name: string;
  classification: 'additive';
}

export interface ServiceRemoved {
  kind: 'service-removed';
  name: string;
  classification: 'breaking';
}

export interface OperationAdded {
  kind: 'operation-added';
  serviceName: string;
  operationName: string;
  classification: 'additive';
}

export interface OperationRemoved {
  kind: 'operation-removed';
  serviceName: string;
  operationName: string;
  classification: 'breaking';
}

export interface OperationModified {
  kind: 'operation-modified';
  serviceName: string;
  operationName: string;
  paramChanges: ParamChange[];
  responseChanged: boolean;
  requestBodyChanged: boolean;
  /**
   * The body stayed but its `requestBodyRequired` flipped. Optional → required
   * is breaking (callers must now send a body); required → optional is additive.
   */
  requestBodyRequiredChanged: boolean;
  httpMethodChanged: boolean;
  pathChanged: boolean;
  paginatedChanged: boolean;
  injectIdempotencyKeyChanged: boolean;
  errorsChanged: boolean;
  /** The `default` or a `1XX`–`5XX` range response was added, removed, or changed type. */
  fallbackResponsesChanged: boolean;
  classification: 'additive' | 'breaking';
}

/**
 * A webhook is identified by its `name` and `httpMethod` together, since one
 * `webhooks` key may declare several methods; a method change therefore
 * reports as one webhook removed and another added.
 */
export interface WebhookAdded {
  kind: 'webhook-added';
  name: string;
  httpMethod: string;
  classification: 'additive';
}

export interface WebhookRemoved {
  kind: 'webhook-removed';
  name: string;
  httpMethod: string;
  classification: 'breaking';
}

/**
 * Changes to a webhook the receiver already handles. Read from the receiver's
 * side: a payload type or encoding change breaks the handler's signature, a
 * body that may now be absent breaks a handler that assumed one, and
 * parameter changes are classified the way a response's would be (see
 * `diffWebhookParams`). Every `ParamChange` carries its `paramLocation`,
 * since a header and a query parameter may share a name.
 */
export interface WebhookModified {
  kind: 'webhook-modified';
  name: string;
  httpMethod: string;
  paramChanges: ParamChange[];
  /** True when the payload's type, encoding, or `requestBodyRequired` changed; `details` says which. */
  requestBodyChanged: boolean;
  /** True when the set of status codes the sender accepts changed; `details` says which (a code removed is breaking). */
  responsesChanged: boolean;
  /** What changed about the body or the accepted responses, e.g. `payload type changed; accepted response 200 removed`. */
  details?: string;
  classification: 'additive' | 'breaking';
}

export interface ParamChange {
  kind:
    | 'param-added'
    | 'param-removed'
    | 'param-type-changed'
    | 'param-format-changed'
    | 'param-required-changed'
    | 'param-default-changed';
  paramName: string;
  classification: 'additive' | 'breaking';
  /** For `param-default-changed`: serialized old default value, or `null` if previously unset. */
  oldDefault?: string | null;
  /** For `param-default-changed`: serialized new default value, or `null` if now unset. */
  newDefault?: string | null;
  /**
   * Where the parameter lives. Set on an operation's `param-default-changed`
   * and on every change of a webhook parameter (whose header, query and
   * cookie parameters may share a name).
   */
  paramLocation?: 'path' | 'query' | 'header' | 'cookie';
  details?: string;
}
