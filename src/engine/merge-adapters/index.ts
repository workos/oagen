import type { MergeAdapter } from './types.js';
import { nodeMergeAdapter } from './node.js';
import { rubyMergeAdapter } from './ruby.js';

const adapters = new Map<string, MergeAdapter>([
  ['node', nodeMergeAdapter],
  ['ruby', rubyMergeAdapter],
]);

export function getMergeAdapter(language: string): MergeAdapter | undefined {
  return adapters.get(language);
}
