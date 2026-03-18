import { resolve, relative } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  packageJson,
  tsconfigJson,
  vitestConfig,
  tsupConfig,
  oagenConfig,
  srcIndex,
  gitignore,
  stubEmitter,
} from './templates/init.js';

export async function initCommand(opts: { lang: string; project?: string }): Promise<void> {
  const projectDir = resolve(opts.project ?? '.');
  const lang = opts.lang;

  if (existsSync(resolve(projectDir, 'package.json'))) {
    throw new Error('Project already initialized — package.json exists');
  }

  // Create directories
  const dirs = [`src/${lang}`, 'test', 'smoke', 'docs/sdk-architecture'];
  for (const dir of dirs) {
    mkdirSync(resolve(projectDir, dir), { recursive: true });
  }

  // Write template files
  const files: Array<[string, string]> = [
    ['package.json', packageJson(lang)],
    ['tsconfig.json', tsconfigJson()],
    ['vitest.config.ts', vitestConfig()],
    ['tsup.config.ts', tsupConfig()],
    ['oagen.config.ts', oagenConfig(lang)],
    ['src/index.ts', srcIndex(lang)],
    ['.gitignore', gitignore()],
    [`src/${lang}/index.ts`, stubEmitter(lang)],
  ];

  for (const [filePath, content] of files) {
    const fullPath = resolve(projectDir, filePath);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  // Print summary
  console.log(`Initialized emitter project for "${lang}" in ${relative(process.cwd(), projectDir) || '.'}`);
  console.log('');
  console.log('Created:');
  for (const [filePath] of files) {
    console.log(`  ${filePath}`);
  }
  for (const dir of dirs) {
    console.log(`  ${dir}/`);
  }

  // Print next steps
  console.log('');
  console.log('Next steps:');
  console.log('  1. npm install');
  console.log(`  2. Implement your emitter in src/${lang}/index.ts`);
  console.log('  3. npm run sdk:generate -- --spec <path-to-spec> --namespace <Name>');
  console.log('  4. npm run sdk:verify -- --spec <path-to-spec>');
}
