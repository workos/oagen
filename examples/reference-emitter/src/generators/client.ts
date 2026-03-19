import type { ApiSpec, GeneratedFile, EmitterContext } from '@workos/oagen';
import { tsClassName } from '../naming.js';

export function generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const lines: string[] = [];
  const className = `${ctx.namespacePascal}Client`;

  // Import resources
  for (const service of spec.services) {
    const lower = service.name.toLowerCase();
    lines.push(`import { ${tsClassName(service.name)} } from './resources/${lower}.js';`);
  }
  lines.push(`import type { ClientConfig } from './config.js';`);
  lines.push('');

  lines.push(`export class ${className} {`);
  lines.push(`  private readonly config: ClientConfig;`);
  lines.push('');

  // Resource accessors
  for (const service of spec.services) {
    const propName = service.name.charAt(0).toLowerCase() + service.name.slice(1);
    lines.push(`  readonly ${propName}: ${tsClassName(service.name)};`);
  }
  lines.push('');

  lines.push(`  constructor(config: ClientConfig) {`);
  lines.push(`    this.config = config;`);
  for (const service of spec.services) {
    const propName = service.name.charAt(0).toLowerCase() + service.name.slice(1);
    lines.push(`    this.${propName} = new ${tsClassName(service.name)}(this.config);`);
  }
  lines.push(`  }`);
  lines.push('}');

  return [{ path: 'client.ts', content: lines.join('\n') }];
}
