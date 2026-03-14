import { nodeEmitter, rubyEmitter } from '../oagen-emitters/src/index.js';
import type { OagenConfig } from './src/cli/config-loader.js';

const config: OagenConfig = {
  emitterProject: '../oagen-emitters',
  emitters: [nodeEmitter, rubyEmitter],
  smokeRunners: { node: '../oagen-emitters/smoke/sdk-node.ts' },
};
export default config;
