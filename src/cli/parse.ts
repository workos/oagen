import { parseSpec } from "../parser/parse.js";

export async function parseCommand(opts: { spec: string }): Promise<void> {
  try {
    const ir = await parseSpec(opts.spec);
    console.log(JSON.stringify(ir, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
