import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUncPath(value) {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function isValidJsonRpcId(id) {
  if (id === null || typeof id === 'string') return true;
  return typeof id === 'number' && Number.isFinite(id);
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function assertNoSymlinksToTarget(resolvedPath) {
  const parsed = parse(resolvedPath);
  const remainder = resolvedPath.slice(parsed.root.length);
  const segments = remainder.split(sep).filter(Boolean);
  let cursor = parsed.root;

  try {
    const rootStat = lstatSync(cursor);
    if (rootStat.isSymbolicLink()) {
      throw new BridgeError('No se permiten enlaces simbólicos en la raíz.');
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new BridgeError('La ruta no existe.');
    }
    throw error;
  }

  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        throw new BridgeError('La ruta no existe.');
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new BridgeError('No se permiten enlaces simbólicos o junctions en la ruta.');
    }
  }
}

function isSafeExecutableFile(candidatePath) {
  if (typeof candidatePath !== 'string') return null;
  const trimmed = candidatePath.trim();
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed) || /\.(?:cmd|bat)$/i.test(trimmed)) return null;
  if (isUncPath(trimmed) || !isAbsolute(trimmed)) return null;

  const resolved = resolve(trimmed);
  if (isUncPath(resolved) || !existsSync(resolved)) return null;

  try {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const real = realpathSync(resolved);
    if (isUncPath(real)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function assertNativeExecutable(executable) {
  if (typeof executable !== 'string' || !executable.trim() || /\.(?:cmd|bat)\s*$/i.test(executable)) {
    throw new BridgeError('El ejecutable debe ser nativo; no se permiten archivos .cmd ni .bat.');
  }
  return executable.trim();
}

/** Serializa únicamente escritores de estos puentes para un mismo cwd. */
export async function withCwdWriteLock(cwd, server, action, lockDir = join(tmpdir(), 'arconte-mcp-bridges-locks')) {
  const plainCwd = assertPlainCwd(cwd);
  if (typeof lockDir !== 'string' || !isAbsolute(lockDir)) {
    throw new BridgeError('El directorio de cerrojos debe ser absoluto y estar fuera del cwd.');
  }
  const directory = resolve(lockDir);
  let boundary = plainCwd;
  for (let cursor = plainCwd; ; cursor = resolve(cursor, '..')) {
    if (existsSync(join(cursor, '.git'))) { boundary = cursor; break; }
    if (resolve(cursor, '..') === cursor) break;
  }
  const inside = relative(boundary, directory);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new BridgeError('El directorio de cerrojos debe estar fuera del cwd.');
  }
  mkdirSync(directory, { recursive: true });
  assertPlainCwd(directory);
  const realBoundary = realpathSync(boundary);
  const key = process.platform === 'win32' ? realBoundary.toLowerCase() : realBoundary;
  const path = join(directory, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const recoveryPath = `${path}.recovery`;
  const owner = { pid: process.pid, servidor: server, hora: new Date().toISOString(), token: randomUUID() };
  const occupied = record => record?.unterminatedTree === true
    ? new BridgeError(`Un escritor previo agotó el tiempo sin confirmar la terminación del árbol de procesos. Se requiere revisión y limpieza manual del cerrojo (${path}) antes de continuar.`)
    : new BridgeError('El cwd ya tiene un escritor activo o un cerrojo que no puede verificarse.');

  function createLock() {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(owner), 'utf8');
    } catch (error) {
      try { unlinkSync(path); } catch { /* conservar el error original */ }
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  function readLock() {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }
  function isOrphan(record) {
    if (record?.unterminatedTree === true) return false;
    if (!Number.isInteger(record?.pid) || record.pid <= 0 ||
        (record.childPid !== undefined && (!Number.isInteger(record.childPid) || record.childPid <= 0))) return false;
    for (const pid of [record.pid, record.childPid].filter(value => value !== undefined)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
    }
    return true;
  }

  function updateLock() {
    const fd = openSync(path, 'r+');
    try {
      const current = JSON.parse(readFileSync(fd, 'utf8'));
      if (current.token !== owner.token) throw new BridgeError('El cerrojo del cwd ya no pertenece a este proceso.');
      const data = Buffer.from(JSON.stringify(owner), 'utf8');
      ftruncateSync(fd, 0);
      let written = 0;
      while (written < data.length) {
        const count = writeSync(fd, data, written, data.length - written, written);
        if (count === 0) throw new BridgeError('No se pudo actualizar el cerrojo del cwd.');
        written += count;
      }
    } finally {
      closeSync(fd);
    }
  }

  let acquired = false;
  try {
    try {
      createLock();
      acquired = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const record = readLock();
      if (!isOrphan(record)) throw occupied(record);
      let recoveryFd;
      try {
        recoveryFd = openSync(recoveryPath, 'wx', 0o600);
      } catch (recoveryError) {
        if (recoveryError?.code === 'EEXIST') throw occupied(readLock());
        throw recoveryError;
      }
      try {
        const current = readLock();
        if (!isOrphan(current)) throw occupied(current);
        unlinkSync(path);
        try {
          createLock();
          acquired = true;
        } catch (createError) {
          if (createError?.code === 'EEXIST') throw occupied(readLock());
          throw createError;
        }
      } finally {
        closeSync(recoveryFd);
        unlinkSync(recoveryPath);
      }
    }

    return await action({
      registerChild(pid) {
        if (!Number.isInteger(pid) || pid <= 0) throw new BridgeError('No se pudo registrar el PID del proceso escritor.');
        owner.childPid = pid;
        updateLock();
      },
      markTreeUnterminated() {
        owner.unterminatedTree = true;
        updateLock();
      },
    });
  } finally {
    if (acquired && !owner.unterminatedTree) {
      try {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (current.token === owner.token) unlinkSync(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

/** En Windows solicita terminar el árbol completo y espera de forma acotada. */
export async function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
  timeoutMs = 5000,
} = {}) {
  let treeTerminated = platform !== 'win32';
  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    treeTerminated = await new Promise(done => {
      let finished = false;
      let killer;
      const finish = success => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(success);
      };
      const timer = setTimeout(() => {
        try { killer?.kill(); } catch { /* mejor esfuerzo */ }
        finish(false);
      }, timeoutMs);
      try {
        killer = spawnProcess(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, env: buildCliEnv(),
        });
        killer.once('error', () => finish(false));
        killer.once('exit', code => finish(code === 0));
      } catch {
        finish(false);
      }
    });
  }
  try { child.kill(); } catch { /* mejor esfuerzo */ }
  return treeTerminated;
}

/** Acumula como máximo maxBytes por flujo, incluso con fragmentos grandes. */
export function appendBoundedOutput(state, chunk, maxBytes) {
  if (state.truncated) return;
  const bytes = Buffer.from(chunk, 'utf8');
  const remaining = Math.max(0, maxBytes - state.bytes);
  if (bytes.length > remaining) state.truncated = true;
  if (remaining > 0) {
    let end = Math.min(remaining, bytes.length);
    if (end < bytes.length) {
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    }
    const kept = bytes.subarray(0, end);
    state.text += kept.toString('utf8');
    state.bytes += kept.length;
  }
}

/**
 * Validates that `cwd` is an existing non-UNC absolute real directory without
 * symbolic links or junctions anywhere in its path chain.
 */
export function assertPlainCwd(cwd) {
  if (typeof cwd !== 'string') {
    throw new BridgeError('cwd debe ser una cadena de ruta absoluta.');
  }
  const trimmed = cwd.trim();
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) {
    throw new BridgeError('cwd contiene caracteres inválidos o está vacío.');
  }
  if (isUncPath(trimmed) || !isAbsolute(trimmed)) {
    throw new BridgeError('cwd debe ser una ruta absoluta local sin prefijo UNC.');
  }

  const resolved = resolve(trimmed);
  if (isUncPath(resolved)) {
    throw new BridgeError('cwd resuelto no puede ser una ruta UNC.');
  }

  assertNoSymlinksToTarget(resolved);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BridgeError('cwd debe ser un directorio real sin enlaces simbólicos.');
  }
  return resolved;
}

/**
 * Resolves a local executable strictly as an existing non-UNC absolute regular
 * file, checking `process.env[envVar]`, `candidatePaths`, and then `PATH`.
 */
export function resolveExecutable(envVar, candidatePaths = [], commandNames = []) {
  if (typeof envVar === 'string' && envVar.trim()) {
    const fromEnv = process.env[envVar.trim()];
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      const verified = isSafeExecutableFile(fromEnv);
      if (verified) return verified;
    }
  }

  if (Array.isArray(candidatePaths)) {
    for (const candidate of candidatePaths) {
      const verified = isSafeExecutableFile(candidate);
      if (verified) return verified;
    }
  }

  const names = Array.isArray(commandNames)
    ? commandNames.filter(
        name => typeof name === 'string' && name.trim() && !/[\\/\0\r\n]/.test(name) && name !== '.' && name !== '..',
      )
    : [];
  const rawPath = process.env.PATH ?? '';
  const pathDirs = rawPath.split(delimiter).map(part => part.trim()).filter(Boolean);

  for (const dir of pathDirs) {
    if (isUncPath(dir) || !isAbsolute(dir) || dir.includes('\0') || /[\r\n]/.test(dir)) {
      continue;
    }
    const resolvedDir = resolve(dir);
    if (isUncPath(resolvedDir)) continue;
    for (const name of names) {
      const verified = isSafeExecutableFile(join(resolvedDir, name));
      if (verified) return verified;
    }
  }

  return null;
}
// Las CLI necesitan rutas locales del sistema y del perfil para localizar su propia sesión.
const CLI_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

export function buildCliEnv(baseEnv = process.env) {
  return Object.fromEntries(Object.entries(baseEnv).filter(
    ([key, value]) => typeof value === 'string' && CLI_ENV_KEYS.has(key.toUpperCase()),
  ));
}

// Solo los errores redactados por el puente pueden llegar al cliente MCP.
export class BridgeError extends Error {}

// La autorización de delegar pertenece al arranque local. Una llamada MCP no puede cambiarla.
export function startBridge(name, createProjectServer, flags = process.argv.slice(2)) {
  if (flags.length === 1 && flags[0] === '--allow-project-data') return createProjectServer().start();
  return createMcpStdioServer({
    name,
    version: '1.0.0',
    instructions: 'Conexión local de ARCONTE. Llama a bridge_ping sin argumentos.',
    tools: [{
      name: 'bridge_ping',
      description: 'Comprueba el transporte MCP con una respuesta fija local.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler(args) {
        if (Object.keys(args).length) throw new BridgeError('bridge_ping se llama sin argumentos.');
        return { text: 'ARCONTE_OK', structuredContent: { ok: true, mode: 'connection-only' } };
      },
    }],
  }).start();
}

// Rechaza la operación completa antes de delegar o persistir el valor.
// Un texto confidencial en lenguaje corriente requiere una decisión humana.
const PRIVATE_TEXT = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\b(?:sk-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.-]{8,}/i,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|contrase(?:ñ|n)a|token|cookie)["']?\s*[:=]\s*["']?[^\s"',;}]+/i,
  /\b[a-z][a-z0-9+.-]{0,24}:\/\/[^/\s@]+:[^/\s@]+@/i,
  /(?:[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/|\\\\[^\\/\s]+\\)[^\\/\s]+/i,
];

const PRIVACY_MESSAGE = 'El puente bloqueó datos potencialmente sensibles.';

function containsPrivateData(value) {
  if (typeof value === 'string') {
    if (value.includes('@') && /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/i.test(value)) return true;
    return PRIVATE_TEXT.some(pattern => pattern.test(value));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => containsPrivateData(key) || containsPrivateData(item));
}

/**
 * Creates a newline-delimited JSON-RPC 2.0 MCP stdio server.
 */
export function createMcpStdioServer({ name, version, instructions, tools = [] }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('createMcpStdioServer requiere `name` no vacío.');
  }
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('createMcpStdioServer requiere `version` no vacío.');
  }

  const normalizedTools = [];
  const toolMap = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || typeof tool.handler !== 'function') {
      throw new Error('Cada herramienta MCP requiere `name` y `handler`.');
    }
    if (toolMap.has(tool.name)) {
      throw new Error(`Herramienta MCP duplicada: ${tool.name}`);
    }
    const descriptor = {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: isPlainObject(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    };
    normalizedTools.push(descriptor);
    toolMap.set(tool.name, tool.handler);
  }

  async function handleMessage(msg) {
    if (!isPlainObject(msg)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }

    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
    if (hasId && !isValidJsonRpcId(msg.id)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }

    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method.trim()) {
      return jsonRpcError(hasId ? msg.id : null, -32600, 'Invalid Request');
    }

    const method = msg.method;

    // Notifications must never emit a response.
    if (method === 'notifications/initialized' || !hasId) {
      return null;
    }

    const id = msg.id;

    switch (method) {
      case 'initialize': {
        if (msg.params !== undefined && !isPlainObject(msg.params)) {
          return jsonRpcError(id, -32602, 'Invalid params');
        }
        const requestedVersion =
          typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : DEFAULT_PROTOCOL_VERSION;

        const result = {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name,
            version,
          },
        };
        if (typeof instructions === 'string' && instructions.trim()) {
          result.instructions = instructions;
        }
        return { jsonrpc: '2.0', id, result };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: normalizedTools,
          },
        };

      case 'tools/call': {
        if (!isPlainObject(msg.params)) {
          return jsonRpcError(id, -32602, 'Invalid params: expected object');
        }
        const toolName = msg.params.name;
        if (typeof toolName !== 'string' || !toolName.trim()) {
          return jsonRpcError(id, -32602, 'Invalid params: missing tool name');
        }
        const handler = toolMap.get(toolName);
        if (!handler) {
          return jsonRpcError(id, -32602, 'Unknown tool');
        }
        const rawArgs = msg.params.arguments;
        if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
          return jsonRpcError(id, -32602, 'Invalid params: arguments must be an object');
        }

        try {
          // cwd solo sirve para dirigir la operación local. No se devuelve al cliente.
          const args = rawArgs ?? {};
          if (Object.entries(args).some(([key, value]) =>
            containsPrivateData(key) || (key !== 'cwd' && containsPrivateData(value)))) {
            throw new BridgeError(PRIVACY_MESSAGE);
          }
          const outcome = await handler(args);
          if (containsPrivateData(outcome)) throw new BridgeError(PRIVACY_MESSAGE);
          const structuredContent =
            outcome && isPlainObject(outcome) ? outcome.structuredContent : undefined;
          const text =
            typeof outcome?.text === 'string'
              ? outcome.text
              : structuredContent !== undefined
                ? JSON.stringify(structuredContent, null, 2)
                : '';

          const result = {
            content: [{ type: 'text', text }],
          };
          if (structuredContent !== undefined) {
            result.structuredContent = structuredContent;
          }
          if (outcome?.isError) {
            result.isError = true;
          }
          return { jsonrpc: '2.0', id, result };
        } catch (error) {
          const message = error instanceof BridgeError ? error.message : 'Falló la operación local del puente.';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: message }],
              isError: true,
            },
          };
        }
      }

      default:
        return jsonRpcError(id, -32601, 'Method not found');
    }
  }

  function start(io = {}) {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    const err = io.err ?? process.stderr;
    const decoder = new StringDecoder('utf8');
    const inFlight = new Set();
    let buffer = '';

    const writeResponse = payload => {
      output.write(`${JSON.stringify(payload)}\n`);
    };

    const dispatchLine = rawLine => {
      const trimmed = rawLine.replace(/\r$/, '').trim();
      if (!trimmed) return;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeResponse(jsonRpcError(null, -32700, 'Parse error'));
        return;
      }

      const task = Promise.resolve()
        .then(() => handleMessage(parsed))
        .then(response => {
          if (response !== null && response !== undefined) {
            writeResponse(response);
          }
        })
        .catch(() => {
          err.write(`[${name}] Error inesperado en stdio MCP.\n`);
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    };

    const onData = chunk => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      buffer += text;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        dispatchLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    };

    return new Promise(resolveDone => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        buffer += decoder.end();
        if (buffer.trim()) {
          dispatchLine(buffer);
          buffer = '';
        }
        if (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
        resolveDone();
      };

      input.on('data', onData);
      input.once('end', () => {
        void finish();
      });
      input.once('close', () => {
        void finish();
      });
      input.once('error', () => {
        err.write(`[${name}] Error en el flujo de entrada.\n`);
        void finish();
      });
      if (typeof input.resume === 'function') {
        input.resume();
      }
    });
  }

  return {
    handleMessage,
    start,
  };
}
