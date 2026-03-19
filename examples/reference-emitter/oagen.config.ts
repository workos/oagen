import type { OagenConfig } from '@workos/oagen';
import { typescriptEmitter } from './src/index.js';

const config: OagenConfig = {
  emitters: [typescriptEmitter],
};
export default config;
