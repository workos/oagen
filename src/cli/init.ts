import { resolve, relative } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  packageJson,
  tsconfigJson,
  vitestConfig,
  tsupConfig,
  oagenConfig,
  srcPlugin,
  srcIndex,
  gitignore,
  stubEmitter,
} from './templates/init.js';

export async function initCommand(opts: { lang: string; project?: string }): Promise<void> {
  const projectDir = resolve(opts.project ?? '.');
  const lang = opts.lang;

  if (existsSync(resolve(projectDir, 'oagen.config.ts'))) {
    throw new Error('Project already initialized — oagen.config.ts exists');
  }

  // Create directories
  const dirs = [`src/${lang}`, 'test', 'smoke', 'docs/sdk-architecture'];
  for (const dir of dirs) {
    mkdirSync(resolve(projectDir, dir), { recursive: true });
  }

  // Write template files
  const files: Array<[string, string]> = [
    ['tsconfig.json', tsconfigJson()],
    ['vitest.config.ts', vitestConfig()],
    ['tsup.config.ts', tsupConfig()],
    ['oagen.config.ts', oagenConfig()],
    ['src/plugin.ts', srcPlugin(lang)],
    ['src/index.ts', srcIndex(lang)],
    [`src/${lang}/index.ts`, stubEmitter(lang)],
  ];

  // Handle package.json specially - merge if it exists
  const packageJsonPath = resolve(projectDir, 'package.json');
  let packageJsonContent: string;
  if (existsSync(packageJsonPath)) {
    const existingContent = readFileSync(packageJsonPath, 'utf-8');
    const existingPkg = JSON.parse(existingContent);
    const newPkg = JSON.parse(packageJson(lang));
    // Merge: existing values take precedence, but append new scripts/devDependencies
    existingPkg.scripts = { ...newPkg.scripts, ...existingPkg.scripts };
    existingPkg.devDependencies = { ...newPkg.devDependencies, ...existingPkg.devDependencies };
    existingPkg.dependencies = { ...newPkg.dependencies, ...existingPkg.dependencies };
    // Only set exports if not already defined
    if (!existingPkg.exports) {
      existingPkg.exports = newPkg.exports;
    }
    // Only set type if not already defined
    if (!existingPkg.type) {
      existingPkg.type = newPkg.type;
    }
    // Only set main if not already defined
    if (!existingPkg.main) {
      existingPkg.main = newPkg.main;
    }
    // Only set types if not already defined
    if (!existingPkg.types) {
      existingPkg.types = newPkg.types;
    }
    packageJsonContent = JSON.stringify(existingPkg, null, 2);
  } else {
    packageJsonContent = packageJson(lang);
  }

  // Handle .gitignore specially - append if it exists
  const gitignorePath = resolve(projectDir, '.gitignore');
  let gitignoreContent: string;
  if (existsSync(gitignorePath)) {
    const existingContent = readFileSync(gitignorePath, 'utf-8');
    const newContent = gitignore();
    // Append new entries that don't already exist (filter out comments and empty lines for comparison)
    const existingLines = new Set(
      existingContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    );
    const newLines = newContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      return trimmed && !existingLines.has(trimmed);
    });
    gitignoreContent = existingContent + (existingContent.endsWith('\n') ? '' : '\n') + newLines.join('\n');
  } else {
    gitignoreContent = gitignore();
  }

  for (const [filePath, content] of files) {
    const fullPath = resolve(projectDir, filePath);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  // Write package.json
  writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');

  // Write .gitignore
  writeFileSync(gitignorePath, gitignoreContent, 'utf-8');

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
  console.log(`  - Implement your emitter in src/${lang}/index.ts`);
  console.log('  - npm run sdk:generate -- --spec <path-to-spec> --namespace <Name>');
  console.log('  - npm run sdk:verify -- --spec <path-to-spec>');
}
