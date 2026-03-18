import { parseSpec } from '../parser/parse.js';

export async function parseCommand(opts: { spec: string }): Promise<void> {
  const ir = await parseSpec(opts.spec);
  console.log(JSON.stringify(ir, null, 2));
}
