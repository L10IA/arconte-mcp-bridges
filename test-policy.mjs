import { dirname, join } from 'node:path';
import { createProjectPolicy } from './bridge-policy.mjs';

export function testPolicy(root, options = {}) {
  return createProjectPolicy({ root, access: 'read-write', stateDir: join(dirname(root), 'bridge-test-state'), ...options });
}
