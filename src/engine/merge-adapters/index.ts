import type { MergeAdapter } from './types.js';
import { dotnetMergeAdapter } from './dotnet.js';
import { elixirMergeAdapter } from './elixir.js';
import { goMergeAdapter } from './go.js';
import { kotlinMergeAdapter } from './kotlin.js';
import { nodeMergeAdapter } from './node.js';
import { phpMergeAdapter } from './php.js';
import { pythonMergeAdapter } from './python.js';
import { rubyMergeAdapter } from './ruby.js';
import { rustMergeAdapter } from './rust.js';

const adapters = new Map<string, MergeAdapter>([
  ['dotnet', dotnetMergeAdapter],
  ['elixir', elixirMergeAdapter],
  ['go', goMergeAdapter],
  ['kotlin', kotlinMergeAdapter],
  ['node', nodeMergeAdapter],
  ['php', phpMergeAdapter],
  ['python', pythonMergeAdapter],
  ['ruby', rubyMergeAdapter],
  ['rust', rustMergeAdapter],
]);

export function getMergeAdapter(language: string): MergeAdapter | undefined {
  return adapters.get(language);
}
