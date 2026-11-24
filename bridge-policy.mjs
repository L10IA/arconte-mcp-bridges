import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { assertPlainCwd, BridgeError, connectionServer, createMcpStdioServer } from './mcp-stdio.mjs';

const identities = ['codex', 'claude-code', 'antigravity'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalidConfig = () => new BridgeError('Configuración local inválida. Revisa la raíz, el acceso y la identidad del buzón.');

function localPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /^[/\\]{2}/.test(value) ||
      value.includes('\0') || /[\r\n]/.test(value) || value.trim() !== value ||
      value.split(process.platform === 'win32' ? /[/\\]/ : '/').includes('..')) throw invalidConfig();
  if (process.platform === 'win32' && (!/^[a-z]:[/\\]/i.test(value) ||
      value.slice(2).split(/[/\\]/).some(p => p && (/[.: ]$|[:*?"<>|]/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))))) throw invalidConfig();
  return resolve(value);
}

function inside(root, candidate) {
  const rest = relative(root, candidate);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
}

// Se comprueba cada componente antes de crear el siguiente, también en el almacén privado.
function directory(path, create) {
  const parts = path.slice(parse(path).root.length).split(sep).filter(Boolean);
  let cursor = parse(path).root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let entry = lstatSync(cursor, { throwIfNoEntry: false });
    if (!entry) {
      if (!create) return null;
      try { mkdirSync(cursor, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      entry = lstatSync(cursor);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new BridgeError('El almacén local requiere directorios reales.');
  }
  return cursor;
}

export function createProjectPolicy({ root, access = 'read-only', mailboxAs = null, stateDir, mailboxDir } = {}) {
  if (!['read-only', 'read-write'].includes(access) || (mailboxAs !== null && !identities.includes(mailboxAs))) throw invalidConfig();
  const canonical = path => realpathSync.native(assertPlainCwd(localPath(path)));
  const project = canonical(root);
  const rootIdentity = lstatSync(project, { bigint: true });
  const normalized = process.platform === 'win32' ? project.toLowerCase() : project;
  const projectKey = createHash('sha256').update([normalized, rootIdentity.dev, rootIdentity.ino].join('|')).digest('hex');
  const base = localPath(stateDir ?? join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'ARCONTE', 'mcp-state'));
  const mail = localPath(mailboxDir ?? process.env.ARCONTE_BUZON_DIR ?? join(base, 'mailboxes'));
  for (const storage of [join(base, 'sessions', projectKey), join(base, 'owners'), join(mail, projectKey)]) {
    if (inside(project, storage) || inside(storage, project)) throw new BridgeError('El estado privado debe estar fuera del proyecto.');
    directory(storage, false);
  }
  function authorize(cwd = project) {
    const activeRoot = canonical(project);
    const stat = lstatSync(activeRoot, { bigint: true });
    if (stat.dev !== rootIdentity.dev || stat.ino !== rootIdentity.ino) throw new BridgeError('La raíz cambió. Vuelve a comprobar la configuración local.');
    const requested = localPath(cwd);
    if (!inside(activeRoot, requested)) throw new BridgeError('La carpeta está fuera del proyecto autorizado.');
    const path = canonical(requested);
    if (!inside(activeRoot, path)) throw new BridgeError('La carpeta está fuera del proyecto autorizado.');
    // En Windows pueden coexistir nombres distintos solo por mayúsculas en una carpeta sensible al caso.
    let ancestor = path;
    for (const _ of relative(activeRoot, path).split(sep).filter(Boolean)) ancestor = dirname(ancestor);
    const actual = lstatSync(ancestor, { bigint: true });
    if (actual.dev !== rootIdentity.dev || actual.ino !== rootIdentity.ino) throw new BridgeError('La carpeta está fuera del proyecto autorizado.');
    return path;
  }
  function sessionDirectory(provider, create) {
    return directory(join(base, 'sessions', projectKey, provider), create);
  }
  function marker(dir, id) {
    const stat = dir && uuid.test(id) ? lstatSync(join(dir, id.toLowerCase()), { throwIfNoEntry: false }) : null;
    return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0 ? stat : null;
  }
  function owned(provider, id) {
    const owners = directory(join(base, 'owners', provider), false);
    if (!owners) return false;
    const path = join(owners, id.toLowerCase());
    const entry = lstatSync(path, { throwIfNoEntry: false });
    return entry?.isFile() && !entry.isSymbolicLink() && entry.size === projectKey.length &&
      readFileSync(path, 'utf8') === projectKey;
  }
  function requireSession(provider, id) {
    if (typeof id !== 'string' || !uuid.test(id) || !marker(sessionDirectory(provider, false), id) || !owned(provider, id)) {
      throw new BridgeError('La sesión no tiene procedencia verificada para este proyecto.');
    }
  }
  function remember(provider, id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new BridgeError('La CLI no devolvió un identificador de sesión válido.');
    const owners = directory(join(base, 'owners', provider), true);
    const target = join(owners, id.toLowerCase());
    if (!owned(provider, id)) {
      const pending = join(owners, '.' + randomUUID());
      writeFileSync(pending, projectKey, { flag: 'wx', mode: 0o600 });
      try { linkSync(pending, target); }
      catch (err) {
        if (err.code !== 'EEXIST' || !owned(provider, id)) throw new BridgeError('La sesión no está disponible en este proyecto.');
      } finally { unlinkSync(pending); }
    }
    const dir = sessionDirectory(provider, true);
    try { closeSync(openSync(join(dir, id.toLowerCase()), 'wx', 0o600)); }
    catch (err) { if (err.code !== 'EEXIST' || !marker(dir, id)) throw err; }
  }
  function sessions(provider, limit) {
    const dir = sessionDirectory(provider, false);
    const entries = [];
    for (const id of dir ? readdirSync(dir) : []) {
      const stat = marker(dir, id);
      if (stat && owned(provider, id)) entries.push({ id, createdAt: stat.mtime.toISOString() });
    }
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { entries: entries.slice(0, limit), total: entries.length };
  }
  return Object.freeze({ root: project, access, mailboxAs, authorize, requireSession, remember, sessions,
    mailboxRoot: create => directory(join(mail, projectKey), create) });
}

export function startBridge(name, factory, flags = process.argv.slice(2)) {
  if (!flags.length) return connectionServer(name).start();
  try {
    const values = new Map();
    for (let i = 0; i < flags.length; i++) {
      const key = flags[i];
      if (values.has(key)) throw invalidConfig();
      if (key === '--allow-project-data') { values.set(key, true); continue; }
      if (!['--project-root', '--access', '--mailbox-as'].includes(key) || !flags[i + 1] || flags[i + 1].startsWith('--')) throw invalidConfig();
      values.set(key, flags[++i]);
    }
    if (!values.has('--allow-project-data') || !values.has('--project-root') ||
        (values.has('--mailbox-as') && name !== 'antigravity-local')) throw invalidConfig();
    const policy = createProjectPolicy({ root: values.get('--project-root'), access: values.get('--access'), mailboxAs: values.get('--mailbox-as') });
    return factory({ policy }).start();
  } catch {
    process.stderr.write('Configuración de delegación rechazada. Usa --allow-project-data --project-root <ruta-absoluta> [--access read-only|read-write].\n');
    process.exitCode = 2;
  }
}

export function projectServer(policy, { name, version, instructions, tools }) {
  const provider = name.replace(/-local$/, '');
  const visible = tools.filter(tool => !tool.name.startsWith('buzon_') || policy.mailboxAs);
  return createMcpStdioServer({ name, version, instructions, tools: visible.map(tool => {
    const properties = tool.inputSchema.properties;
    return { ...tool, handler: async args => {
      if (Object.keys(args).some(k => !Object.hasOwn(properties, k))) throw new BridgeError('Argumento no admitido por esta herramienta.');
      const writing = args.sandbox === 'workspace-write' || ['edit', 'accept-edits'].includes(args.mode) ||
        ['buzon_send', 'buzon_archive'].includes(tool.name);
      if (writing && policy.access !== 'read-write') throw new BridgeError('Esta instancia solo permite lectura.');
      const cwd = policy.authorize(Object.hasOwn(args, 'cwd') ? args.cwd : policy.root);
      const input = Object.hasOwn(properties, 'cwd') ? { ...args, cwd } : args;
      const sessionField = provider === 'antigravity' ? 'conversationId' : 'sessionId';
      if (Object.hasOwn(input, sessionField)) policy.requireSession(provider, input[sessionField]);
      const outcome = await tool.handler(input);
      const id = outcome?.structuredContent?.[sessionField];
      if (outcome?.structuredContent?.ok && id && !input.ephemeral) policy.remember(provider, id);
      return outcome;
    } };
  }) });
}
