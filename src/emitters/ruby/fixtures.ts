import type { TypeRef, Model, ApiSpec } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { rubyFileName } from './naming.js';

export function generateFixtures(spec: ApiSpec, _ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const model of spec.models) {
    const fixture = generateFixtureForModel(model, spec);
    files.push({
      path: `test/fixtures/${rubyFileName(model.name)}.json`,
      content: JSON.stringify(fixture, null, 2) + '\n',
    });
  }

  return files;
}

function generateFixtureForModel(model: Model, spec: ApiSpec): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const field of model.fields) {
    obj[field.name] = generateFixtureValue(field.type, field.name, spec);
  }
  return obj;
}

function generateFixtureValue(typeRef: TypeRef, fieldName: string, spec: ApiSpec): unknown {
  switch (typeRef.kind) {
    case 'primitive':
      return generatePrimitiveFixture(typeRef.type, typeRef.format, fieldName);
    case 'array':
      return [generateFixtureValue(typeRef.items, fieldName, spec)];
    case 'model': {
      const model = spec.models.find((m) => m.name === typeRef.name);
      if (model) return generateFixtureForModel(model, spec);
      return {};
    }
    case 'enum': {
      const e = spec.enums.find((en) => en.name === typeRef.name);
      return e?.values[0]?.value ?? 'unknown';
    }
    case 'nullable':
      return generateFixtureValue(typeRef.inner, fieldName, spec);
    case 'union':
      if (typeRef.variants.length > 0) {
        return generateFixtureValue(typeRef.variants[0], fieldName, spec);
      }
      return null;
  }
}

function generatePrimitiveFixture(type: string, format: string | undefined, fieldName: string): unknown {
  if (type === 'string') {
    if (format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
    if (format === 'date') return '2024-01-01';
    if (format === 'date-time') return '2024-01-01T00:00:00Z';
    if (format === 'email') return `test@example.com`;
    return `test_${fieldName}`;
  }
  if (type === 'integer') return 1;
  if (type === 'number') return 1.0;
  if (type === 'boolean') return true;
  return null;
}
