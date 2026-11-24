import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createProjectPolicy } from './bridge-policy.mjs';

export function testPolicy(root, options = {}) {
  return createProjectPolicy({ root, access: 'read-write', stateDir: join(dirname(root), 'bridge-test-state'), ...options });
}

export function testEnv(base) {
  const profile = join(base, 'perfil-de-prueba');
  const temp = join(base, 'temporal-de-prueba');
  mkdirSync(profile, { recursive: true });
  mkdirSync(temp, { recursive: true });
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: dirname(process.execPath), HOME: profile, USERPROFILE: profile,
    APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile,
    XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile, TEMP: temp, TMP: temp, TMPDIR: temp,
  };
}
