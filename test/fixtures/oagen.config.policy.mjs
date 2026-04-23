/**
 * Test config with consumer policy: transforms, hints, mount rules, and smoke runners.
 * Used by config propagation tests.
 */
export default {
  operationIdTransform: (id) => id.replace(/^list/, 'getAll'),
  schemaNameTransform: (name) => name.replace(/Dto$/, ''),
  docUrl: 'https://test.example.com/docs',
  operationHints: {
    'GET /users': { name: 'fetch_all_users' },
  },
  mountRules: {
    Organizations: 'Admin',
  },
  smokeRunners: {
    node: './smoke/custom-node.ts',
    python: './smoke/custom-python.ts',
  },
};
