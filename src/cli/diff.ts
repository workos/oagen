import { parseSpec } from '../parser/parse.js';
import { diffSpecs } from '../differ/diff.js';
import { CommandError } from '../errors.js';
import { expandDocUrls } from '../utils/expand-doc-urls.js';

export async function diffCommand(opts: {
  old: string;
  new: string;
  operationIdTransform?: (id: string) => string;
  docUrl?: string;
}): Promise<void> {
  const parseOptions = { operationIdTransform: opts.operationIdTransform };
  let [oldSpec, newSpec] = await Promise.all([
    parseSpec(opts.old, parseOptions),
    parseSpec(opts.new, parseOptions),
  ]);
  if (opts.docUrl) {
    oldSpec = expandDocUrls(oldSpec, opts.docUrl);
    newSpec = expandDocUrls(newSpec, opts.docUrl);
  }

  const diff = diffSpecs(oldSpec, newSpec);
  console.log(JSON.stringify(diff, null, 2));
  throw new CommandError(
    '',
    '',
    diff.summary.breaking > 0
      ? 2
      : diff.summary.modified > 0 || diff.summary.removed > 0
        ? 1
        : diff.summary.added > 0
          ? 1
          : 0,
  );
}
