export interface DiffReport {
  oldVersion: string;
  newVersion: string;
  changes: Change[];
  /**
   * Cross-cutting events that a type signature does not show: a parameter
   * default changing observable runtime behavior for callers who never set it
   * explicitly (breaking), or an IR node becoming or ceasing to be deprecated
   * (additive). Surfaced separately so PR-description and changelog tooling
   * can call them out even when the shapes in `changes` are otherwise
   * unchanged. Every entry here mirrors a flag or nested entry on a change in
   * `changes`, so the totals in `summary` count each event once.
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

export type BehaviorChange = ParamDefaultChanged | DeprecatedChanged;

export interface ParamDefaultChanged {
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

/**
 * An IR node became deprecated, or stopped being deprecated. The node is still
 * there with the same shape, so nothing a caller compiles against changes and
 * the event is additive; it is surfaced here, beside the `deprecatedChanged`
 * flag or `*-deprecated-changed` entry on the owning change, so a changelog
 * can say it. `undefined` and `false` both read as not deprecated, as the
 * parser only ever writes `true`.
 */
export type DeprecatedChanged = {
  kind: 'deprecated-changed';
  /** Whether the node was deprecated in the old spec. Always the opposite of `newDeprecated`. */
  oldDeprecated: boolean;
  /** Whether the node is deprecated in the new spec. */
  newDeprecated: boolean;
  classification: 'additive';
} & DeprecatedNode;

/** Which IR node a `deprecated-changed` entry is about, named the way the owning change names it. */
export type DeprecatedNode =
  | { node: 'operation'; serviceName: string; operationName: string }
  | {
      node: 'parameter';
      serviceName: string;
      operationName: string;
      paramName: string;
      paramLocation: 'path' | 'query' | 'header';
    }
  | { node: 'model'; modelName: string }
  | { node: 'field'; modelName: string; fieldName: string }
  | { node: 'enum'; enumName: string }
  | { node: 'enum-value'; enumName: string; valueName: string };

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
  /**
   * The model's own `deprecated` flipped. Additive either way: the model and
   * its fields are unchanged. A model whose only change is this flag is still
   * reported, with an empty `fieldChanges`.
   */
  deprecatedChanged: boolean;
  classification: 'additive' | 'breaking';
}

export interface FieldChange {
  kind:
    | 'field-added'
    | 'field-removed'
    | 'field-type-changed'
    | 'field-format-changed'
    | 'field-required-changed'
    | 'field-access-changed'
    | 'field-deprecated-changed';
  fieldName: string;
  classification: 'additive' | 'breaking';
  /** For `field-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
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
  /**
   * The enum's own `deprecated` flipped. Additive either way: the values are
   * unchanged. An enum whose only change is this flag is still reported, with
   * an empty `valueChanges`.
   */
  deprecatedChanged: boolean;
  classification: 'additive' | 'breaking';
}

export interface EnumValueChange {
  kind: 'value-added' | 'value-removed' | 'value-changed' | 'value-deprecated-changed';
  valueName: string;
  classification: 'additive' | 'breaking';
  /** For `value-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
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
   * The operation's own `deprecated` flipped. Additive either way: the
   * signature is unchanged. A parameter's flag flipping is a
   * `param-deprecated-changed` entry in `paramChanges` instead.
   */
  deprecatedChanged: boolean;
  classification: 'additive' | 'breaking';
}

export interface ParamChange {
  kind:
    | 'param-added'
    | 'param-removed'
    | 'param-type-changed'
    | 'param-format-changed'
    | 'param-required-changed'
    | 'param-default-changed'
    | 'param-deprecated-changed';
  paramName: string;
  classification: 'additive' | 'breaking';
  /** For `param-default-changed`: serialized old default value, or `null` if previously unset. */
  oldDefault?: string | null;
  /** For `param-default-changed`: serialized new default value, or `null` if now unset. */
  newDefault?: string | null;
  /** For `param-default-changed` and `param-deprecated-changed`: 'query' | 'header' | 'path' — where the parameter lives. */
  paramLocation?: 'path' | 'query' | 'header';
  /** For `param-deprecated-changed`: `live → deprecated` or `deprecated → live`. */
  details?: string;
}
