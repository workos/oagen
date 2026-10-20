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
  /** 'path' | 'query' | 'header'. */
  paramLocation: 'path' | 'query' | 'header';
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
  | OperationModified;

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
  /**
   * True when a response entry gained or lost a media type, or a secondary
   * media type's body type changed; `responseContentTypeChanges` says which.
   */
  responseContentTypesChanged: boolean;
  responseContentTypeChanges: ResponseContentTypesChange[];
  classification: 'additive' | 'breaking';
}

/**
 * How one response entry's media types changed between two specs. Entries
 * pair up by status code — alternate 2xx entries from `successResponses`,
 * errors from `errors` — except the primary success response, which is read
 * from the operation's own `responseContentTypes` and carries no code in the
 * IR, so it is reported with `statusCode` unset. Media types are compared as
 * written and as sets: reordering them is no change, while a key that only
 * gained a parameter is one removed and one added.
 */
export interface ResponseContentTypesChange {
  statusCode?: number;
  /** Media types the new spec declares and the old did not: callers gain a representation to ask for. */
  added: string[];
  /** Media types the old spec declared and the new does not: a representation callers could ask for is gone. */
  removed: string[];
  /**
   * Media types declared by both whose body type changed, other than the one
   * the entry's own `type` is read from, which `responseChanged` and
   * `errorsChanged` already report.
   */
  retyped: string[];
  /** `breaking` when anything was removed or retyped, else `additive`. */
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
  /** For `param-default-changed`: 'query' | 'header' | 'path' — where the parameter lives. */
  paramLocation?: 'path' | 'query' | 'header';
  details?: string;
}
