import type { MergeAdapter } from './types.js';
import { nodeMergeAdapter } from './node.js';
import { phpMergeAdapter } from './php.js';
import { pythonMergeAdapter } from './python.js';
import { rubyMergeAdapter } from './ruby.js';

const adapters = new Map<string, MergeAdapter>([
  ['node', nodeMergeAdapter],
  ['php', phpMergeAdapter],
  ['python', pythonMergeAdapter],
  ['ruby', rubyMergeAdapter],
]);

export function getMergeAdapter(language: string): MergeAdapter | undefined {
  return adapters.get(language);
}
