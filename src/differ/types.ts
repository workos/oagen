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
  | OperationModified
  | BaseUrlChanged
  | ServerAdded
  | ServerRemoved
  | ServerModified;

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

/**
 * `ApiSpec.baseUrl` — the first server's URL with its variables' defaults
 * filled in — differs, so a client built on the default host sends its
 * requests somewhere else. Reported once per diff whatever moved it: a
 * changed `servers[0]` template (also a `server-removed` plus a
 * `server-added`), a changed variable default (also a `server-modified`), a
 * reordered list, or a `servers` list that appeared or disappeared.
 */
export interface BaseUrlChanged {
  kind: 'base-url-changed';
  /** `''` when the old document declared no server. */
  oldBaseUrl: string;
  /** `''` when the new document declares no server. */
  newBaseUrl: string;
  /**
   * Breaking when the default host moves or disappears. Additive when the old
   * document declared no server: every existing caller had to name a host
   * themselves and still can.
   */
  classification: 'additive' | 'breaking';
}

export interface ServerAdded {
  kind: 'server-added';
  /** The URL template as written in the document, placeholders included. */
  url: string;
  classification: 'additive';
}

export interface ServerRemoved {
  kind: 'server-removed';
  /** The URL template as written in the document, placeholders included. */
  url: string;
  classification: 'breaking';
}

/**
 * A server present in both documents — matched on its `url` template,
 * position-independent; a template declared more than once is matched as a
 * multiset, see `diffServers` — whose variables changed. A changed template is
 * a `server-removed` plus a `server-added` instead.
 */
export interface ServerModified {
  kind: 'server-modified';
  url: string;
  variableChanges: ServerVariableChange[];
  classification: 'additive' | 'breaking';
}

export interface ServerVariableChange {
  kind:
    | 'variable-added'
    | 'variable-removed'
    | 'variable-default-changed'
    | 'variable-enum-added'
    | 'variable-enum-removed'
    | 'variable-enum-value-added'
    | 'variable-enum-value-removed';
  variableName: string;
  classification: 'additive' | 'breaking';
  /** For `variable-default-changed`: the previous default. */
  oldDefault?: string;
  /** For `variable-default-changed`: the new default. */
  newDefault?: string;
  /** For `variable-enum-value-added` / `variable-enum-value-removed`: the value. */
  value?: string;
  details?: string;
}
