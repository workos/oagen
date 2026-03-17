import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDocumentFromString, bundleDocument, createConfig, BaseResolver } from '@redocly/openapi-core';
import { SpecParseError } from '../errors.js';

export interface BundledSpec {
  parsed: Record<string, unknown>;
  specPath: string;
}

export async function loadAndBundleSpec(specPath: string): Promise<BundledSpec> {
  const absolutePath = resolve(specPath);
  const content = await readFile(absolutePath, 'utf-8');
  const document = makeDocumentFromString(content, pathToFileURL(absolutePath).href);

  const config = await createConfig({});
  const resolver = new BaseResolver();

  const result = await bundleDocument({
    document,
    config: config.styleguide,
    externalRefResolver: resolver,
    dereference: false,
  });

  if (result.problems.some((p) => p.severity === 'error')) {
    const errors = result.problems
      .filter((p) => p.severity === 'error')
      .map((p) => p.message)
      .join('\n');
    throw new SpecParseError(
      `Failed to parse spec: ${errors}`,
      `Check the OpenAPI spec at "${absolutePath}" for syntax errors. Run a linter such as \`npx @redocly/cli lint ${specPath}\` to identify issues.`,
    );
  }

  return {
    parsed: result.bundle.parsed as Record<string, unknown>,
    specPath: absolutePath,
  };
}
