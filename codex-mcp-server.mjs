import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendBoundedOutput,
  assertNativeExecutable,
  assertPlainCwd,
  connectionServer,
  resolveExecutable,
  BridgeError,
  buildCliEnv,
  terminateProcessTree,
  withCwdWriteLock,
} from './mcp-stdio.mjs';
import { projectServer, startBridge } from './bridge-policy.mjs';

const SERVER_NAME = 'codex-local';
const SERVER_VERSION = '0.1.15';
const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write']);
const DEFAULT_TIMEOUT_SEC = 240;
const MAX_TIMEOUT_SEC = 600;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function assertNoSymlinksToFile(filePath) {
  const parsed = parse(filePath);
  const segments = filePath.slice(parsed.root.length).split(sep).filter(Boolean);
  let cursor = parsed.root;
  try {
    if (lstatSync(cursor).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validateCodexExePath(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return null;
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//') || !isAbsolute(trimmed)) return null;
  const resolved = resolve(trimmed);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return null;
  if (!resolved.toLowerCase().endsWith(`${sep}codex.exe`)) {
    return null;
  }
  if (!existsSync(resolved) || !assertNoSymlinksToFile(resolved)) return null;
  try {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const real = realpathSync(resolved);
    if (real.startsWith('\\\\') || real.startsWith('//')) return null;
    return resolved;
  } catch {
    return null;
  }
}

function unescapeTomlBasic(value) {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

/**
 * Reads `~/.codex/config.toml` strictly read-only to locate a verified newer
 * Codex Desktop CLI binary (`codex.exe`) without ever modifying user config.
 */
export function discoverCodexDesktopExecutable(homeDir = homedir()) {
  if (typeof homeDir !== 'string' || !homeDir.trim()) return null;
  const configPath = join(homeDir, '.codex', 'config.toml');
  try {
    if (!existsSync(configPath)) return null;
    const cfgStat = lstatSync(configPath);
    if (cfgStat.isSymbolicLink() || !cfgStat.isFile() || !assertNoSymlinksToFile(resolve(configPath))) {
      return null;
    }
    const content = readFileSync(configPath, 'utf8').split(/\r?\n/)
      .filter(line => !/^\s*#/.test(line)).join('\n');
    const candidates = [];

    for (const match of content.matchAll(/^[ \t]*CODEX_CLI_PATH[ \t]*=[ \t]*(?:'([^'\r\n]+)'|"([^"\r\n]+)")/gm)) {
      const raw = match[1] ?? (match[2] ? unescapeTomlBasic(match[2]) : '');
      if (raw) candidates.push(raw);
    }

    for (const match of content.matchAll(/^[ \t]*notify[ \t]*=[ \t]*\[\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)")/gm)) {
      const rawNotify = match[1] ?? (match[2] ? unescapeTomlBasic(match[2]) : '');
      const markerMatch = /^(.*?[\\/]+app[\\/]+resources)(?:[\\/]|$)/i.exec(rawNotify);
      if (markerMatch?.[1]) {
        candidates.push(join(markerMatch[1], 'codex.exe'));
      }
    }

    for (const candidate of candidates) {
      const validated = validateCodexExePath(candidate);
      if (validated) return validated;
    }
    return null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertSafeCliValue(value, label) {
  if (typeof value !== 'string') {
    throw new BridgeError(`${label} debe ser texto.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.startsWith('-') || /[\0\r\n]/.test(trimmed)) {
    throw new BridgeError(`${label} inválido.`);
  }
  return trimmed;
}

function normalizeTimeoutMs(timeoutSec) {
  if (timeoutSec === undefined) return DEFAULT_TIMEOUT_SEC * 1000;
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new BridgeError(`timeoutSec debe estar entre 1 y ${MAX_TIMEOUT_SEC} segundos.`);
  }
  return Math.round(timeoutSec * 1000);
}

function parseVisibleModels(rawResult) {
  const rawList = Array.isArray(rawResult?.data)
    ? rawResult.data
    : Array.isArray(rawResult?.models)
      ? rawResult.models
      : [];
  const all = rawList
    .map(item => {
      const obj = isPlainObject(item) ? item : {};
      const id = typeof obj.id === 'string' ? obj.id : typeof obj.model === 'string' ? obj.model : '';
      const model = typeof obj.model === 'string' ? obj.model : id;
      const displayName = typeof obj.displayName === 'string' ? obj.displayName : undefined;
      return {
        id,
        model,
        isDefault: obj.isDefault === true,
        hidden: obj.hidden === true,
        ...(displayName ? { displayName } : {}),
      };
    })
    .filter(entry => entry.id.length > 0 || entry.model.length > 0);
  const visible = all.filter(entry => !entry.hidden);
  return { all, visible };
}

export function resolveCompatibleCodexModel(configuredModel, modelListResult) {
  const { all, visible } = parseVisibleModels(modelListResult);
  const configured = typeof configuredModel === 'string' && configuredModel.trim() ? configuredModel.trim() : null;
  if (configured && all.some(entry => entry.id === configured || entry.model === configured)) {
    return {
      configuredModel: configured,
      effectiveDefaultModel: configured,
      visibleModels: visible,
    };
  }
  const preferred =
    visible.find(entry => entry.isDefault) ??
    all.find(entry => entry.isDefault) ??
    visible[0] ??
    all[0] ??
    null;
  return {
    configuredModel: configured,
    effectiveDefaultModel: preferred ? (preferred.model || preferred.id) : configured,
    visibleModels: visible,
  };
}

function parseCodexJsonl(stdoutText) {
  let sessionId = null;
  const messages = [];

  for (const rawLine of String(stdoutText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(evt)) continue;
    if (evt.type === 'thread.started' && typeof evt.thread_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(evt.thread_id)) {
      sessionId = evt.thread_id.trim();
    } else if (evt.type === 'item.completed' && isPlainObject(evt.item)) {
      if (evt.item.type === 'agent_message' && typeof evt.item.text === 'string' && evt.item.text.trim()) {
        messages.push(evt.item.text);
      }
    }
  }

  return { sessionId, messages };
}

async function defaultReadCliVersion(executable, env, cwd, spawnProcess = spawn, terminate = terminateProcessTree) {
  return new Promise(resolveVersion => {
    let stdout = '';
    let settled = false;
    const child = spawnProcess(executable, ['--version'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try { await terminate(child); } catch { /* mejor esfuerzo */ }
      resolveVersion(null);
    }, 5000);
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (stdout.length < 4096) stdout += chunk.slice(0, 4096 - stdout.length);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveVersion(null);
    });
    child.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const firstLine = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? null;
      resolveVersion(firstLine);
    });
  });
}

export async function defaultProbeAppServer(executable, env, cwd, { spawnProcess = spawn, terminate = terminateProcessTree } = {}) {
  const cliVersionPromise = defaultReadCliVersion(executable, env, cwd, spawnProcess, terminate);

  const probePromise = new Promise((resolveProbe, rejectProbe) => {
    const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    let settled = false;
    const pending = new Map();

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const req of pending.values()) {
        req.reject(err ?? new Error('Sonda app-server finalizada.'));
      }
      pending.clear();
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      if (err) rejectProbe(err);
      else resolveProbe(value);
    };

    const timer = setTimeout(async () => {
      try { await terminate(child); } catch { /* mejor esfuerzo */ }
      finish(new Error('Tiempo agotado al consultar codex app-server.'));
    }, 15000);

    let seq = 0;
    const send = payload => {
      if (!settled) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    };
    const request = (method, params) => {
      const id = ++seq;
      return new Promise((resolveReq, rejectReq) => {
        pending.set(id, { resolve: resolveReq, reject: rejectReq });
        send({ id, method, params });
      });
    };

    child.stderr.resume();
    child.stdin.on('error', error => finish(error));
    child.once('error', err => finish(err));
    child.once('exit', code => {
      if (!settled) {
        finish(new Error(`codex app-server terminó inesperadamente (exit=${code ?? 'null'}).`));
      }
    });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
        finish(new Error('La respuesta de la sonda Codex excedió el límite permitido.'));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error('Falló una consulta a codex app-server.'));
          } else {
            entry.resolve(isPlainObject(msg.result) ? msg.result : {});
          }
        }
      }
    });

    (async () => {
      await request('initialize', {
        clientInfo: { name: 'arconte-mcp', title: 'ARCONTE MCP', version: SERVER_VERSION },
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized' });
      const [accountRes, configRes, modelListRes] = await Promise.all([
        request('account/read', { refreshToken: false }),
        request('config/read', { cwd }),
        request('model/list', {}).catch(() => ({ data: [] })),
      ]);
      const account = isPlainObject(accountRes.account) ? accountRes.account : {};
      const config = isPlainObject(configRes.config) ? configRes.config : {};
      const modelResolution = resolveCompatibleCodexModel(config.model, modelListRes);
      finish(null, {
        account: { type: account.type === 'chatgpt' ? 'chatgpt' : null },
        ...modelResolution,
      });
    })().catch(err => finish(err));
  });

  const [cliVersion, probeData] = await Promise.all([cliVersionPromise, probePromise]);
  return {
    cliVersion,
    ...probeData,
  };
}

export async function defaultRunCodexExec({ executable, args, cwd, prompt, env, timeoutMs, tmpOutFile, spawnProcess = spawn, terminate = terminateProcessTree, onSpawn }) {
  const startedAt = Date.now();
  return new Promise((resolveExec, rejectExec) => {
    const child = spawnProcess(assertNativeExecutable(executable), args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      onSpawn?.(child.pid);
    } catch (error) {
      child.once('error', () => {});
      child.stdin?.on('error', () => {});
      void Promise.resolve().then(() => terminate(child)).catch(() => {}).finally(() => rejectExec(error));
      return;
    }

    const stdout = { text: '', bytes: 0, truncated: false };
    const stderr = { text: '', bytes: 0, truncated: false };
    let settled = false;

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      let treeTerminated = false;
      try { treeTerminated = (await terminate(child)) !== false; } catch { /* mejor esfuerzo */ }
      resolveExec({ exitCode: 124, stdout: stdout.text, stderr: stderr.text,
        durationMs: Date.now() - startedAt, timedOut: true, outputFileText: '',
        truncated: stdout.truncated || stderr.truncated, treeTerminated });
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', chunk => {
      appendBoundedOutput(stdout, chunk, MAX_BUFFER_BYTES);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      appendBoundedOutput(stderr, chunk, MAX_BUFFER_BYTES);
    });
    child.stdin.on('error', () => {
      /* Process may exit before reading full stdin; handled on close. */
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectExec(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let outputFileText = '';
      let fileTruncated = false;
      if (tmpOutFile && existsSync(tmpOutFile)) {
        let fd;
        try {
          fd = openSync(tmpOutFile, 'r');
          const buf = Buffer.alloc(MAX_BUFFER_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buf.length) {
            const count = readSync(fd, buf, bytesRead, buf.length - bytesRead, bytesRead);
            if (count === 0) break;
            bytesRead += count;
          }
          fileTruncated = bytesRead > MAX_BUFFER_BYTES;
          outputFileText = buf.subarray(0, Math.min(bytesRead, MAX_BUFFER_BYTES)).toString('utf8');
        } catch {
          outputFileText = '';
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
      resolveExec({
        exitCode: typeof code === 'number' ? code : -1,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        outputFileText,
        truncated: stdout.truncated || stderr.truncated || fileTruncated,
      });
    });

    if (typeof prompt === 'string' && prompt.length > 0) {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

function buildReviewArgs({ cwd, model, uncommitted, base, hasPrompt, tmpOutFile }) {
  if (uncommitted && base) {
    throw new BridgeError('Especifica uncommitted o base, no ambos a la vez.');
  }

  // Clap en codex exec review rechaza combinar --uncommitted o --base con [PROMPT].
  // Si llegan instrucciones personalizadas junto con uncommitted/base, usamos codex exec read-only.
  if (hasPrompt && (uncommitted || base)) {
    return {
      useGenericExec: true,
      args: [
        'exec',
        '-C',
        cwd,
        '-s',
        'read-only',
        ...(model ? ['-m', model] : []),
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--ephemeral',
        '--json',
        '-o',
        tmpOutFile,
        '-',
      ],
    };
  }

  const args = [
    'exec',
    '-C',
    cwd,
    '-s',
    'read-only',
    '--ignore-user-config',
    'review',
    ...(model ? ['-m', model] : []),
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '-o',
    tmpOutFile,
  ];

  if (hasPrompt) {
    args.push('-');
  } else if (base) {
    args.push('--base', base);
  } else {
    args.push('--uncommitted');
  }

  return { useGenericExec: false, args };
}

export function createCodexMcpServer(options = {}) {
  const { policy } = options;
  if (!policy) return connectionServer(SERVER_NAME);
  const getBaseEnv = () => options.baseEnv ?? process.env;
  const getCleanEnv = () => buildCliEnv(getBaseEnv());
  const getDefaultCwd = () => policy.root;

  const resolveCodexBin = () => {
    if (options.resolveCodex) {
      const candidate = options.resolveCodex();
      return candidate ? assertNativeExecutable(candidate) : null;
    }
    if (typeof options.executable === 'string' && options.executable.trim()) {
      return assertNativeExecutable(options.executable);
    }
    const env = getBaseEnv();
    const envCodexBin = typeof env.CODEX_BIN === 'string' ? env.CODEX_BIN.trim() : '';
    const desktopExe = discoverCodexDesktopExecutable(options.homeDir ?? homedir());
    const localAppData = env.LOCALAPPDATA ?? '';
    const candidatePaths = [
      ...(localAppData ? [join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : []),
      ...(desktopExe ? [desktopExe] : []),
    ];
    if (envCodexBin) {
      const verifiedEnv = resolveExecutable('', [envCodexBin], []);
      if (verifiedEnv) return policy.installedExecutable(verifiedEnv);
    }
    return policy.installedExecutable(resolveExecutable('', candidatePaths, ['codex.exe', 'codex']));
  };

  const probeFn = options.probeCodex ?? ((exe, env, cwd) => defaultProbeAppServer(exe, env, cwd, {
    spawnProcess: options.spawnProcess, terminate: options.terminateProcessTree,
  }));
  const execFn = options.runCodexExec ?? (params => defaultRunCodexExec({
    ...params, spawnProcess: options.spawnProcess, terminate: options.terminateProcessTree,
  }));

  async function probeSafe(cwd, executablePath = resolveCodexBin(), cleanEnv = getCleanEnv()) {
    if (!executablePath) {
      return {
        executablePath: null,
        cliVersion: null,
        account: { type: null },
        configuredModel: null,
        effectiveDefaultModel: null,
        visibleModels: [],
        error: 'No se localizó codex.exe en CODEX_BIN, ruta estándar ni PATH.',
      };
    }
    try {
      const probe = await probeFn(executablePath, cleanEnv, policy.authorize(cwd));
      const modelResolution =
        Array.isArray(probe?.visibleModels) && probe.effectiveDefaultModel !== undefined
          ? {
              configuredModel: probe.configuredModel ?? null,
              effectiveDefaultModel: probe.effectiveDefaultModel ?? null,
              visibleModels: probe.visibleModels,
            }
          : resolveCompatibleCodexModel(probe?.configuredModel ?? null, probe?.modelList ?? probe?.models ?? {});
      const version = probe?.cliVersion;
      return {
        executablePath,
        cliVersion: typeof version === 'string' && /^(?:codex-cli )?\d+\.\d+\.\d+$/.test(version) ? version : null,
        account: { type: probe?.account?.type === 'chatgpt' ? 'chatgpt' : null },
        ...modelResolution,
        error: null,
      };
    } catch {
      return {
        executablePath,
        cliVersion: null,
        account: { type: null },
        configuredModel: null,
        effectiveDefaultModel: null,
        visibleModels: [],
        error: 'No se pudo consultar la instalación de Codex.',
      };
    }
  }

  const tools = [
    {
      name: 'codex_status',
      description: 'Inspecciona la instalación local de Codex CLI, cuenta ChatGPT y modelo efectivo sin consumir tokens.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const probe = await probeSafe(getDefaultCwd());
        const ok = Boolean(probe.executablePath && !probe.error && probe.account.type);
        const structuredContent = {
          ok,
          available: Boolean(probe.executablePath),
          cliVersion: probe.cliVersion,
          configuredModel: probe.configuredModel,
          effectiveDefaultModel: probe.effectiveDefaultModel,
          supportedModelCount: probe.visibleModels.length,
          ...(probe.error ? { error: probe.error } : {}),
        };
        return {
          text: ok
            ? [
                `Codex ${probe.cliVersion ?? 'disponible'}.`,
                `Modelo configurado: ${probe.configuredModel ?? 'n/a'} | Modelo efectivo: ${probe.effectiveDefaultModel ?? 'predeterminado'} | Modelos compatibles: ${probe.visibleModels.length}`,
              ].join('\n')
            : `Codex no disponible: ${probe.error ?? 'cuenta no verificada'}`,
          structuredContent,
          isError: !ok,
        };
      },
    },
    {
      name: 'codex_models',
      description: 'Lista los modelos compatibles reportados por codex app-server model/list sin consumir tokens.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const probe = await probeSafe(getDefaultCwd());
        const ok = Boolean(probe.executablePath && !probe.error);
        const models = probe.visibleModels.map(m => ({
          id: m.id,
          model: m.model,
          isDefault: Boolean(m.isDefault),
          ...(m.displayName ? { displayName: m.displayName } : {}),
        }));
        const structuredContent = {
          ok,
          configuredModel: probe.configuredModel,
          effectiveDefaultModel: probe.effectiveDefaultModel,
          models,
          ...(probe.error ? { error: probe.error } : {}),
        };
        const modelLines = models.map(
          m => `- ${m.model}${m.displayName ? ` (${m.displayName})` : ''}${m.isDefault ? ' · default' : ''}`,
        );
        return {
          text: ok
            ? [
                `${models.length} modelo(s) compatibles (configurado: ${probe.configuredModel ?? 'n/a'}, predeterminado efectivo: ${probe.effectiveDefaultModel ?? 'n/a'}):`,
                ...modelLines,
              ].join('\n')
            : `No se pudieron listar modelos de Codex: ${probe.error}`,
          structuredContent,
          isError: !ok,
        };
      },
    },
    {
      name: 'codex_ask',
      description: 'Consulta Codex con cuenta ChatGPT y prompt por stdin. En read-only se ignora la configuración del usuario, pero los MCP de proyecto o administrados aún pueden ejecutarse fuera del sandbox.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Ruta absoluta real del directorio de trabajo (sin symlinks).' },
          prompt: { type: 'string', description: 'Instrucción enviada por stdin.' },
          model: { type: 'string', description: 'Modelo opcional a usar.' },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write'],
            default: 'read-only',
          },
          sessionId: { type: 'string', description: 'ID de sesión previo para continuar con codex exec resume.' },
          ephemeral: { type: 'boolean', default: false },
          timeoutSec: { type: 'number', minimum: 1, maximum: MAX_TIMEOUT_SEC, default: DEFAULT_TIMEOUT_SEC },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async args => {
        const safeCwd = assertPlainCwd(args.cwd);
        if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
          throw new BridgeError('prompt es obligatorio y no puede estar vacío.');
        }
        const sandbox = args.sandbox ?? 'read-only';
        if (!ALLOWED_SANDBOXES.has(sandbox)) {
          throw new BridgeError('Sandbox inválido. Usa read-only o workspace-write.');
        }
        const timeoutMs = normalizeTimeoutMs(args.timeoutSec);
        if (args.ephemeral !== undefined && typeof args.ephemeral !== 'boolean') {
          throw new BridgeError('ephemeral debe ser booleano.');
        }
        const ephemeral = args.ephemeral ?? false;
        const sessionId =
          args.sessionId !== undefined && args.sessionId !== null && args.sessionId !== ''
            ? assertSafeCliValue(args.sessionId, 'sessionId')
            : null;
        const explicitModel =
          args.model !== undefined && args.model !== null && args.model !== ''
            ? assertSafeCliValue(args.model, 'model')
            : null;

        const executablePath = resolveCodexBin();
        if (!executablePath) {
          throw new BridgeError('No se localizó codex.exe en el equipo.');
        }

        const cleanEnv = getCleanEnv();
        const run = async lock => {
          if (!ephemeral) policy.prepareSession('codex');
          const probe = await probeSafe(safeCwd, executablePath, cleanEnv);
          if (probe.error || probe.account.type !== 'chatgpt') {
            throw new BridgeError('Se requiere una cuenta ChatGPT verificada antes de ejecutar Codex.');
          }
          const selectedModel = explicitModel ?? probe.effectiveDefaultModel;
          const cwd = policy.authorize(safeCwd);
          const tmpOutFile = policy.outputFile();
          const execArgs = sessionId
            ? [
                'exec',
                '-C',
                cwd,
                '-s',
                sandbox,
                ...(sandbox === 'read-only' ? ['--ignore-user-config'] : []),
                'resume',
                ...(selectedModel ? ['-m', selectedModel] : []),
                '--skip-git-repo-check',
                ...(ephemeral ? ['--ephemeral'] : []),
                '--json',
                '-o',
                tmpOutFile,
                sessionId,
                '-',
              ]
            : [
                'exec',
                '-C',
                cwd,
                '-s',
                sandbox,
                ...(selectedModel ? ['-m', selectedModel] : []),
                ...(sandbox === 'read-only' ? ['--ignore-user-config'] : []),
                '--skip-git-repo-check',
                ...(ephemeral ? ['--ephemeral'] : []),
                '--json',
                '-o',
                tmpOutFile,
                '-',
              ];
          try {
            const outcome = await execFn({
              executable: executablePath,
              args: execArgs,
              cwd,
              prompt: args.prompt,
              env: cleanEnv,
              timeoutMs,
              tmpOutFile,
              onSpawn: lock?.registerChild,
            });
            if (outcome.timedOut && outcome.treeTerminated !== true) lock?.markTreeUnterminated?.();
            return { result: outcome, selectedModel };
          } finally {
            rmSync(tmpOutFile, { force: true });
          }
        };
        const { result, selectedModel } = sandbox === 'workspace-write'
          ? await withCwdWriteLock(policy.root, SERVER_NAME, run, options.lockDir ?? policy.lockDirectory())
          : await run();
        const parsed = parseCodexJsonl(result.stdout);
        const answer = (result.outputFileText ?? '').trim() || parsed.messages.join('\n\n').trim();
        const ok = result.exitCode === 0 && !result.timedOut && !result.truncated && answer.length > 0;
        const failureReason = result.timedOut
          ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s).${result.treeTerminated !== true ? ' No se pudo confirmar la terminación del árbol de procesos.' : ''}`
          : result.truncated ? 'La salida de Codex fue truncada por exceder el límite permitido.'
          : `Codex no completó la consulta (código ${result.exitCode}).`;

        const finalSessionId = ephemeral ? null : parsed.sessionId ?? sessionId;
        const structuredContent = {
          ok,
          sessionId: finalSessionId,
          model: selectedModel,
          sandbox,
          answer: ok ? answer : '',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };

        const metaFooter = finalSessionId
          ? `\n\n[codex-local · model=${selectedModel ?? 'default'} · sessionId=${finalSessionId}]`
          : `\n\n[codex-local · model=${selectedModel ?? 'default'}]`;

        return {
          text: ok ? `${answer}${metaFooter}` : failureReason,
          structuredContent,
          isError: !ok,
        };
      },
    },
    {
      name: 'codex_review',
      description: 'Revisa código con sandbox read-only e ignora la configuración del usuario; los MCP de proyecto o administrados aún pueden ejecutarse fuera del sandbox.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Ruta absoluta real del repositorio o directorio.' },
          prompt: { type: 'string', description: 'Instrucciones opcionales de revisión.' },
          base: { type: 'string', description: 'Rama o commit base para revisar cambios.' },
          uncommitted: { type: 'boolean', description: 'Revisar cambios staged, unstaged y untracked.' },
          model: { type: 'string' },
          timeoutSec: { type: 'number', minimum: 1, maximum: MAX_TIMEOUT_SEC, default: DEFAULT_TIMEOUT_SEC },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async args => {
        const safeCwd = assertPlainCwd(args.cwd);
        const timeoutMs = normalizeTimeoutMs(args.timeoutSec);
        if (args.uncommitted !== undefined && typeof args.uncommitted !== 'boolean') {
          throw new BridgeError('uncommitted debe ser booleano.');
        }
        const uncommitted = args.uncommitted ?? false;
        if (uncommitted && args.base) throw new BridgeError('Especifica uncommitted o base, no ambos a la vez.');
        const base =
          args.base !== undefined && args.base !== null && args.base !== ''
            ? assertSafeCliValue(args.base, 'base')
            : null;
        const rawPrompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : null;
        const explicitModel =
          args.model !== undefined && args.model !== null && args.model !== ''
            ? assertSafeCliValue(args.model, 'model')
            : null;

        const executablePath = resolveCodexBin();
        if (!executablePath) {
          throw new BridgeError('No se localizó codex.exe en el equipo.');
        }

        const cleanEnv = getCleanEnv();
        const probe = await probeSafe(safeCwd, executablePath, cleanEnv);
        if (probe.error || probe.account.type !== 'chatgpt') {
          throw new BridgeError('Se requiere una cuenta ChatGPT verificada antes de ejecutar Codex.');
        }
        const selectedModel = explicitModel ?? probe.effectiveDefaultModel;

        policy.authorize(safeCwd);
        const tmpOutFile = policy.outputFile();
        const { useGenericExec, args: reviewArgs } = buildReviewArgs({
          cwd: safeCwd,
          model: selectedModel,
          uncommitted,
          base,
          hasPrompt: Boolean(rawPrompt),
          tmpOutFile,
        });

        let stdinPrompt = rawPrompt ?? '';
        if (useGenericExec && rawPrompt) {
          const scopeLine = base
            ? `Revisa en modo solo lectura los cambios respecto a la referencia git "${base}".`
            : 'Revisa en modo solo lectura los cambios pendientes (uncommitted) del repositorio.';
          stdinPrompt = `${scopeLine}\n\nInstrucciones:\n${rawPrompt}`;
        }

        try {
          const result = await execFn({
            executable: executablePath,
            args: reviewArgs,
            cwd: safeCwd,
            prompt: stdinPrompt,
            env: cleanEnv,
            timeoutMs,
            tmpOutFile,
          });
          const parsed = parseCodexJsonl(result.stdout);
          const review = (result.outputFileText ?? '').trim() || parsed.messages.join('\n\n').trim();
          const ok = result.exitCode === 0 && !result.timedOut && !result.truncated && review.length > 0;
          const failureReason = result.timedOut
            ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s).${result.treeTerminated !== true ? ' No se pudo confirmar la terminación del árbol de procesos.' : ''}`
            : result.truncated ? 'La salida de Codex fue truncada por exceder el límite permitido.'
            : `Codex no completó la revisión (código ${result.exitCode}).`;

          const structuredContent = {
            ok,
            model: selectedModel,
            review: ok ? review : '',
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          };

          return {
            text: ok ? review : failureReason,
            structuredContent,
            isError: !ok,
          };
        } finally {
          rmSync(tmpOutFile, { force: true });
        }
      },
    },
  ];

  return projectServer(policy, {
    name: SERVER_NAME,
    version: options.version ?? SERVER_VERSION,
    instructions:
      'Puente MCP local hacia Codex CLI: verifica una cuenta ChatGPT y retira credenciales del entorno. Otros ajustes del CLI pueden influir en proveedor y destino; no modifica ~/.codex/config.toml.',
    tools,
  });
}

const isEntrypoint = Boolean(process.argv[1]) &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    (process.platform === 'win32' &&
      import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()));

if (isEntrypoint) {
  await startBridge(SERVER_NAME, createCodexMcpServer);
}
