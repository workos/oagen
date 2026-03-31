import { it, expect } from 'vitest';
import { extractClassEndLines } from '../../src/engine/merger.js';

it('debug class end', async () => {
  const source = [
    'from typing import Optional',
    '',
    'class Webhooks:',
    '    """Webhooks API resources."""',
    '',
    '    def list(self):',
    '        """List Webhook Endpoints',
    '',
    'Get a list of all existing webhook endpoints.',
    '',
    '        Args:',
    '            limit: Max records.',
    '        """',
    '        pass',
    '',
    '    def create(self):',
    '        pass',
    '',
    '',
    'class AsyncWebhooks:',
    '    async def list(self):',
    '        pass',
  ].join('\n');

  const map = await extractClassEndLines(source, 'python');
  for (const [name, info] of map) {
    const lines = source.split('\n');
    console.log(
      `${name}: bodyEndLine=${info.bodyEndLine}, line content: ${JSON.stringify(lines[info.bodyEndLine - 1])}`,
    );
  }
  expect(map.get('Webhooks')!.bodyEndLine).toBeGreaterThan(17);
});
