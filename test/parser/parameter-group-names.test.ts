import { describe, it, expect } from 'vitest';
import { assignParameterGroupWrapperNames } from '../../src/parser/parameter-group-names.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type {
  ApiSpec,
  Enum,
  Model,
  Operation,
  Parameter,
  ParameterGroup,
  Service,
  TypeRef,
} from '../../src/ir/types.js';

const str: TypeRef = { kind: 'primitive', type: 'string' };
const int: TypeRef = { kind: 'primitive', type: 'integer' };

function nullable(inner: TypeRef): TypeRef {
  return { kind: 'nullable', inner };
}

function param(name: string, type: TypeRef = str): Parameter {
  return { name, type, required: true };
}

function group(name: string, parameters: Parameter[], variantName = 'default'): ParameterGroup {
  return { name, optional: false, variants: [{ name: variantName, parameters }] };
}

function op(name: string, parameterGroups: ParameterGroup[]): Operation {
  return {
    name,
    httpMethod: 'post',
    path: `/${name}`,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
    parameterGroups,
  };
}

function service(name: string, operations: Operation[]): Service {
  return { name, operations };
}

function spec(services: Service[], extra: { enums?: Enum[]; models?: Model[] } = {}): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: 'https://api.example.com',
    services,
    models: extra.models ?? [],
    enums: extra.enums ?? [],
    sdk: defaultSdkBehavior(),
  };
}

/** Every group in the spec, in traversal order. */
function groupsOf(s: ApiSpec): ParameterGroup[] {
  return s.services.flatMap((svc) => svc.operations.flatMap((o) => o.parameterGroups ?? []));
}

describe('assignParameterGroupWrapperNames', () => {
  it('keeps the bare group name when every declaration agrees', () => {
    const s = spec([
      service('users', [
        op('create', [group('password', [param('password'), param('password_hash')])]),
        op('update', [group('password', [param('password'), param('password_hash')])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['password', 'password']);
  });

  it('ignores member order when deciding whether declarations agree', () => {
    const s = spec([
      service('users', [
        op('create', [group('password', [param('password'), param('password_hash')])]),
        op('update', [group('password', [param('password_hash'), param('password')])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['password', 'password']);
  });

  it('qualifies with the operation name when declarations genuinely diverge', () => {
    const s = spec([
      service('connections', [
        op('create', [group('protocol_options', [param('saml_options'), param('extra_field')])]),
        op('patch', [group('protocol_options', [param('saml_options')])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['create_protocol_options', 'patch_protocol_options']);
  });

  it('treats two inline copies of one enum as the same type', () => {
    // The parser synthesizes a distinct name per declaration site for inline
    // enums, so identical enums arrive under different names. That must not
    // read as divergence and rename an already-published wrapper.
    const enums: Enum[] = [
      { name: 'CreateUserPasswordHashType', values: [{ name: 'bcrypt', value: 'bcrypt' }] },
      { name: 'UpdateUserPasswordHashType', values: [{ name: 'bcrypt', value: 'bcrypt' }] },
    ];
    const s = spec(
      [
        service('users', [
          op('create', [group('password', [param('hash', { kind: 'enum', name: 'CreateUserPasswordHashType' })])]),
          op('update', [group('password', [param('hash', { kind: 'enum', name: 'UpdateUserPasswordHashType' })])]),
        ]),
      ],
      { enums },
    );

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['password', 'password']);
  });

  it('distinguishes enums whose values stringify alike but differ in primitive type', () => {
    const enums: Enum[] = [
      { name: 'CreateRetries', values: [{ name: 'five', value: 5 }] },
      { name: 'UpdateRetries', values: [{ name: 'five', value: '5' }] },
    ];
    const s = spec(
      [
        service('jobs', [
          op('create', [group('retry', [param('count', { kind: 'enum', name: 'CreateRetries' })])]),
          op('update', [group('retry', [param('count', { kind: 'enum', name: 'UpdateRetries' })])]),
        ]),
      ],
      { enums },
    );

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['create_retry', 'update_retry']);
  });

  it('service-qualifies when two services share an operation name and the groups diverge', () => {
    // Operation names are unique only within a service, so `create_password`
    // alone is not a unique wrapper key.
    const s = spec([
      service('users', [op('create', [group('password', [param('password')])])]),
      service('admins', [op('create', [group('password', [param('password'), param('password_hash')])])]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['users_create_password', 'admins_create_password']);
  });

  it('leaves a shared name alone when two services agree, even sharing an operation name', () => {
    const s = spec([
      service('users', [op('create', [group('password', [param('password')])])]),
      service('admins', [op('create', [group('password', [param('password')])])]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['password', 'password']);
  });

  it('settles a member the sharers disagree on as non-nullable', () => {
    const plain = param('id');
    const maybe = param('id', nullable(str));
    const s = spec([
      service('resources', [
        op('create', [group('parent_resource', [plain])]),
        op('update', [group('parent_resource', [maybe])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['parent_resource', 'parent_resource']);
    expect(plain.type).toEqual(str);
    expect(maybe.type).toEqual(str);
  });

  it('keeps a member every sharer agrees is nullable nullable', () => {
    const a = param('id', nullable(str));
    const b = param('id', nullable(str));
    const s = spec([
      service('resources', [
        op('create', [group('parent_resource', [a])]),
        op('update', [group('parent_resource', [b])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(a.type).toEqual(nullable(str));
    expect(b.type).toEqual(nullable(str));
  });

  it('aligns member order on the first sharer so positional constructors agree', () => {
    const second = group('password', [param('password_hash'), param('password')]);
    const s = spec([
      service('users', [
        op('create', [group('password', [param('password'), param('password_hash')])]),
        op('update', [second]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(second.variants[0].parameters.map((p) => p.name)).toEqual(['password', 'password_hash']);
  });

  it('does not treat a differing `optional` flag as divergence', () => {
    // Whether the group as a whole may be omitted belongs to the operation
    // signature, not to the wrapper type.
    const s = spec([
      service('users', [
        op('create', [{ ...group('password', [param('password')]), optional: false }]),
        op('update', [{ ...group('password', [param('password')]), optional: true }]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['password', 'password']);
  });

  it('distinguishes declarations that differ only in a member primitive type', () => {
    const s = spec([
      service('jobs', [
        op('create', [group('retry', [param('count', int)])]),
        op('update', [group('retry', [param('count', str)])]),
      ]),
    ]);

    assignParameterGroupWrapperNames(s);

    expect(groupsOf(s).map((g) => g.wrapperName)).toEqual(['create_retry', 'update_retry']);
  });
});
