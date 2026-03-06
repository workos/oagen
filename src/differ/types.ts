export interface DiffReport {
  oldVersion: string;
  newVersion: string;
  changes: Change[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    breaking: number;
    additive: number;
  };
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
  kind: 'field-added' | 'field-removed' | 'field-type-changed' | 'field-required-changed';
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
  httpMethodChanged: boolean;
  pathChanged: boolean;
  paginatedChanged: boolean;
  idempotentChanged: boolean;
  errorsChanged: boolean;
  classification: 'additive' | 'breaking';
}

export interface ParamChange {
  kind: 'param-added' | 'param-removed' | 'param-type-changed' | 'param-required-changed';
  paramName: string;
  classification: 'additive' | 'breaking';
}
