import { parseSpec } from '../parser/parse.js';
import { diffSpecs } from '../differ/diff.js';
import { generateIncremental } from '../engine/incremental.js';
import { getEmitter, registerEmitter } from '../engine/registry.js';
import { rubyEmitter } from '../emitters/ruby/index.js';

registerEmitter(rubyEmitter);

export async function diffCommand(opts: {
  old: string;
  new: string;
  lang?: string;
  output?: string;
  report?: boolean;
  force?: boolean;
}): Promise<void> {
  const oldSpec = await parseSpec(opts.old);
  const newSpec = await parseSpec(opts.new);

  if (opts.report) {
    const diff = diffSpecs(oldSpec, newSpec);
    console.log(JSON.stringify(diff, null, 2));
    process.exit(diff.summary.breaking > 0 ? 2 : diff.summary.added > 0 ? 1 : 0);
  }

  if (!opts.lang || !opts.output) {
    console.error('--lang and --output are required for incremental generation');
    process.exit(1);
  }

  const emitter = getEmitter(opts.lang);
  const result = await generateIncremental(oldSpec, newSpec, emitter, {
    namespace: newSpec.name,
    outputDir: opts.output,
    force: opts.force,
  });

  if (result.diff.changes.length === 0) {
    console.log('No changes detected');
  } else {
    console.log(`Regenerated ${result.generated.length} files`);
    if (result.deleted.length > 0) {
      console.log(`Deleted ${result.deleted.length} files`);
    }
    if (!opts.force && result.diff.changes.some((c) => c.kind.endsWith('-removed'))) {
      console.log('Use --force to delete files for removed schemas');
    }
  }
}
