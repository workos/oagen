import { parseSpec } from '../parser/parse.js';
import { generate } from '../engine/orchestrator.js';
import { getEmitter, registerEmitter } from '../engine/registry.js';
import { rubyEmitter } from '../emitters/ruby/index.js';

// Register built-in emitters
registerEmitter(rubyEmitter);

export async function generateCommand(opts: {
  spec: string;
  lang: string;
  output: string;
  namespace?: string;
  dryRun?: boolean;
}): Promise<void> {
  try {
    const ir = await parseSpec(opts.spec);
    const emitter = getEmitter(opts.lang);
    const namespace = opts.namespace ?? ir.name;

    const files = await generate(ir, emitter, {
      namespace,
      dryRun: opts.dryRun,
      outputDir: opts.output,
    });

    if (opts.dryRun) {
      for (const f of files) {
        console.log(f.path);
      }
    } else {
      console.log(`Generated ${files.length} files in ${opts.output}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
