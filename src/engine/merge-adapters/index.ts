import type { MergeAdapter } from './types.js';
import { goMergeAdapter } from './go.js';
import { nodeMergeAdapter } from './node.js';
import { phpMergeAdapter } from './php.js';
import { pythonMergeAdapter } from './python.js';
import { rubyMergeAdapter } from './ruby.js';
import { rustMergeAdapter } from './rust.js';

const adapters = new Map<string, MergeAdapter>([
  ['go', goMergeAdapter],
  ['node', nodeMergeAdapter],
  ['php', phpMergeAdapter],
  ['python', pythonMergeAdapter],
  ['ruby', rubyMergeAdapter],
  ['rust', rustMergeAdapter],
]);

export function getMergeAdapter(language: string): MergeAdapter | undefined {
  return adapters.get(language);
}
