import { spawn } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendBoundedOutput,
  assertNativeExecutable,
  assertPlainCwd,
  createMcpStdioServer,
  resolveExecutable,
  BridgeError,
  buildCliEnv,
  startBridge,
  terminateProcessTree,
  withCwdWriteLock,
} from './mcp-stdio.mjs';

const DEFAULT_MODEL = 'claude-fable-5-2';
const DEFAULT_TIMEOUT_SEC = 240;
const MAX_TIMEOUT_SEC = 600;
const STATUS_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const READ_ONLY_ALLOWED_TOOLS = 'Read,Grep,Glob';
const READ_ONLY_DISALLOWED_TOOLS = 'Edit,Write,NotebookEdit';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_MODES = new Set(['read-only', 'plan', 'edit']);
// Identificadores vigentes de la familia Claude 5 y los alias que resuelve el propio CLI.
// Al publicarse un modelo nuevo hay que añadirlo aquí: un valor fuera de la lista se rechaza.
const VALID_MODELS = new Set([
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'fable',
  'opus',
  'sonnet',
  'haiku',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function assertModel(value) {
  if (typeof value !== 'string' || !VALID_MODELS.has(value)) {
    throw new BridgeError('model inválido; debe pertenecer a la lista de modelos permitidos.');
  }
  return value;
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new BridgeError('sessionId debe ser un UUID válido.');
  }
  return value;
}

function isolatedSettingsArgs(mode) {
  return mode === 'read-only' || mode === 'plan' ? ['--setting-sources', 'user', '--strict-mcp-config'] : [];
}

function parseTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC * 1000;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > MAX_TIMEOUT_SEC) {
    throw new BridgeError(`timeoutSec debe ser un entero entre 5 y ${MAX_TIMEOUT_SEC}.`);
  }
  return Math.round(value * 1000);
}

function parseMaxTurns(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new BridgeError('maxTurns debe ser un entero entre 1 y 50.');
  }
  return value;
}

export function buildClaudeCliArgs({
  model,
  mode,
  sessionId,
  maxTurns,
}) {
  const args = ['-p', '--model', model, '--output-format', 'json', ...isolatedSettingsArgs(mode)];
  if (sessionId) args.push('--resume', sessionId);
  if (maxTurns !== undefined) args.push('--max-turns', String(maxTurns));

  if (mode === 'read-only') {
    args.push(
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      READ_ONLY_ALLOWED_TOOLS,
      '--tools',
      READ_ONLY_ALLOWED_TOOLS,
      '--disallowedTools',
      READ_ONLY_DISALLOWED_TOOLS,
    );
  } else if (mode === 'plan') {
    args.push('--permission-mode', 'plan');
  } else if (mode === 'edit') {
    args.push('--permission-mode', 'acceptEdits');
  } else {
    throw new BridgeError('Modo inválido. Usa read-only, plan o edit.');
  }
  return args;
}

export function parseClaudeJsonResult(
  stdout,
  stderr,
  exitCode,
  { model, mode, fallbackSessionId = null, fallbackDurationMs = 0 },
) {
  const trimmed = String(stdout ?? '').trim();


  if (trimmed) {
    for (const candidate of [trimmed, ...trimmed.split(/\r?\n/).reverse()]) {
      const line = candidate.trim();
      if (!line.startsWith('{') && !line.startsWith('[')) continue;
      try {
        const rawParsed = JSON.parse(line);
        const parsed = Array.isArray(rawParsed)
          ? asObject(
              [...rawParsed].reverse().find(item => item && typeof item === 'object' && item.type === 'result') ??
                rawParsed.at(-1),
            )
          : asObject(rawParsed);
        if (Object.keys(parsed).length === 0 || (parsed.type !== undefined && parsed.type !== 'result')) continue;
        const rawId = parsed.session_id ?? parsed.sessionId;
        const sessionId = typeof rawId === 'string' && SESSION_ID.test(rawId) ? rawId : fallbackSessionId;
        const resultText = typeof parsed.result === 'string' ? parsed.result.trim() : '';
        const hasErrorsArray = Array.isArray(parsed.errors) && parsed.errors.length > 0;
        const isError = parsed.is_error === true || hasErrorsArray || exitCode !== 0 || !resultText;
        const numTurns =
          typeof parsed.num_turns === 'number' && Number.isFinite(parsed.num_turns)
            ? parsed.num_turns
            : typeof parsed.numTurns === 'number' && Number.isFinite(parsed.numTurns)
              ? parsed.numTurns
              : null;
        const durationMs =
          typeof parsed.duration_ms === 'number' && Number.isFinite(parsed.duration_ms)
            ? parsed.duration_ms
            : typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)
              ? parsed.durationMs
              : fallbackDurationMs;
        const finalResult = isError ? 'Claude Code no devolvió una respuesta válida.' : resultText;
        return {
          ok: !isError && exitCode === 0,
          sessionId,
          model,
          mode,
          result: finalResult,
          numTurns,
          durationMs,
          isError,
          exitCode,
        };
      } catch {
        /* Try next line candidate. */
      }
    }
  }


  return {
    ok: false,
    sessionId: fallbackSessionId,
    model,
    mode,
    result: 'Claude Code no devolvió una respuesta válida.',
    numTurns: null,
    durationMs: fallbackDurationMs,
    isError: true,
    exitCode,
  };
}

function defaultSpawnProcess(command, args, cwd, env) {
  return spawn(assertNativeExecutable(command), args, { cwd, env, stdio: 'pipe', windowsHide: true });
}

export async function defaultRunProcess({
  executable,
  args,
  cwd,
  env,
  stdinText,
  timeoutMs,
  spawnProcess = defaultSpawnProcess,
  terminate = terminateProcessTree,
  onSpawn,
}) {
  const startedAt = Date.now();
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const stdout = { text: '', bytes: 0, truncated: false };
    const stderr = { text: '', bytes: 0, truncated: false };
    let child;

    try {
      child = spawnProcess(executable, args, cwd, env);
      onSpawn?.(child.pid);
    } catch (error) {
      if (child) {
        child.once('error', () => {});
        child.stdin?.on('error', () => {});
        void Promise.resolve().then(() => terminate(child)).catch(() => {}).finally(() => rejectPromise(error));
      } else {
        rejectPromise(error);
      }
      return;
    }

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      let treeTerminated = false;
      try { treeTerminated = (await terminate(child)) !== false; } catch { /* mejor esfuerzo */ }
      resolvePromise({
        stdout: stdout.text,
        stderr: `${stderr.text}\nTiempo de espera agotado (${Math.round(timeoutMs / 1000)}s).${treeTerminated ? '' : ' No se pudo confirmar la terminación del árbol de procesos.'}`.trim(),
        exitCode: 124,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        timedOut: true,
        treeTerminated,
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', chunk => {
      appendBoundedOutput(stdout, chunk, MAX_BUFFER_BYTES);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      appendBoundedOutput(stderr, chunk, MAX_BUFFER_BYTES);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    child.stdin.on('error', () => {
      /* Child may exit quickly before stdin finishes draining. */
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText, 'utf8', () => child.stdin.end());
    } else {
      child.stdin.end();
    }
  });
}

function assertPlainDirectoryEntry(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BridgeError(`No se permiten enlaces simbólicos ni rutas no válidas en ${label}.`);
  }
}

function listClaudeSessionsForCwd({ cwd, claudeHome, limit = 20 }) {
  const plainCwd = assertPlainCwd(cwd);
  const resolvedCwd = resolve(plainCwd);
  const slug = resolvedCwd.replace(/[^a-zA-Z0-9]/g, '-');
  const projectsDir = join(claudeHome, 'projects');

  try {
    assertPlainDirectoryEntry(claudeHome, 'directorio Claude');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { sessions: [], total: 0, skippedSymlinks: 0 };
    }
    throw error;
  }

  try {
    assertPlainDirectoryEntry(projectsDir, 'projects de Claude');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { sessions: [], total: 0, skippedSymlinks: 0 };
    }
    throw error;
  }

  const slugDir = join(projectsDir, slug);
  try {
    assertPlainDirectoryEntry(slugDir, 'directorio del proyecto');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { sessions: [], total: 0, skippedSymlinks: 0 };
    }
    throw error;
  }

  let skippedSymlinks = 0;
  const all = [];
  for (const name of readdirSync(slugDir)) {
    if (!name.endsWith('.jsonl') || !SESSION_ID.test(name.slice(0, -6))) continue;
    const filePath = join(slugDir, name);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    all.push({
      sessionId: name.slice(0, -6),
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  all.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  const sessions = all.slice(0, limit).map(({ sessionId, modifiedAt, sizeBytes }) => ({
    sessionId,
    modifiedAt,
    sizeBytes,
  }));

  return {
    sessions,
    total: all.length,
    skippedSymlinks,
  };
}

function buildReviewPrompt({ target, focus }) {
  const parts = [
    'Realiza una auditoría técnica estrictamente de SOLO LECTURA sobre este repositorio.',
    'Está prohibido editar, crear o borrar archivos.',
    target ? `Alcance / objetivo específico: ${target}` : 'Alcance: cambios recientes y módulos principales del proyecto.',
    focus ? `Enfoque prioritario: ${focus}` : 'Enfoque: bugs reales, seguridad (path traversal, symlinks, autoridad, fugas), carreras y regresiones.',
    'Estructura tu respuesta por severidad P0 (crítico), P1 (alto) y P2 (observaciones menores), citando siempre ruta de archivo y línea exacta.',
    'Si no hay hallazgos en alguna severidad, indícalo explícitamente sin inventar fallos.',
  ];
  return parts.join('\n');
}

export function createClaudeCodeMcpServer(options = {}) {
  const baseEnv = options.env ?? process.env;
  const homeDirectory = options.homeDir ?? homedir();
  const claudeHome = options.claudeHome ?? join(homeDirectory, '.claude');
  const resolveBinary =
    options.resolveExecutable ??
    (() =>
      resolveExecutable(
        'CLAUDE_BIN',
        [join(homeDirectory, '.local', 'bin', 'claude.exe')],
        ['claude.exe', 'claude'],
      ));
  const runProcess =
    options.runProcess ??
    (params => defaultRunProcess({ ...params, spawnProcess: options.spawnProcess, terminate: options.terminateProcessTree }));

  const sanitizedEnv = () => buildCliEnv(baseEnv);
  const getExecutable = () => {
    const executable = options.executable ?? resolveBinary();
    return executable ? assertNativeExecutable(executable) : null;
  };

  async function readAuth(executable, cwd, mode, env) {
    const authRes = await runProcess({
      executable,
      args: [...isolatedSettingsArgs(mode), 'auth', 'status', '--json'],
      cwd,
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (authRes.exitCode !== 0 || authRes.truncated) return {};
    try {
      const parsed = asObject(JSON.parse(String(authRes.stdout ?? '').trim()));
      return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod === 'claude.ai' ? 'claude.ai' : null };
    } catch {
      return {};
    }
  }

  async function executeClaudePrompt({
    cwd,
    prompt,
    model = DEFAULT_MODEL,
    sessionId,
    mode = 'read-only',
    maxTurns,
    timeoutSec,
  }) {
    const plainCwd = assertPlainCwd(cwd);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
      throw new BridgeError('El parámetro prompt es obligatorio y no puede contener caracteres nulos.');
    }
    const chosenModel = assertModel(model);
    if (!VALID_MODES.has(mode)) {
      throw new BridgeError('Modo inválido. Valores permitidos: read-only, plan, edit.');
    }
    const cleanSessionId =
      sessionId === undefined ? null : assertSessionId(sessionId);
    const cleanMaxTurns = parseMaxTurns(maxTurns);
    const timeoutMs = parseTimeoutMs(timeoutSec);

    const executable = getExecutable();
    if (!executable) {
      throw new BridgeError(
        'No se encontró claude.exe (ni en CLAUDE_BIN, ~/.local/bin/claude.exe o PATH).',
      );
    }

    const args = buildClaudeCliArgs({
      model: chosenModel,
      mode,
      sessionId: cleanSessionId,
      maxTurns: cleanMaxTurns,
    });

    const env = sanitizedEnv();
    const run = async lock => {
      const auth = await readAuth(executable, plainCwd, mode, env);
      if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai') {
        throw new BridgeError('Se requiere una sesión de suscripción claude.ai verificada antes de ejecutar Claude Code.');
      }
      const outcome = await runProcess({ executable, args, cwd: plainCwd, env, stdinText: prompt, timeoutMs, onSpawn: lock?.registerChild });
      if (outcome.timedOut && outcome.treeTerminated !== true) lock?.markTreeUnterminated?.();
      return outcome;
    };
    const outcome = mode === 'edit'
      ? await withCwdWriteLock(plainCwd, 'claude-code-local', run, options.lockDir)
      : await run();

    const structured = parseClaudeJsonResult(outcome.stdout, outcome.stderr, outcome.exitCode, {
      model: chosenModel,
      mode,
      fallbackSessionId: cleanSessionId,
      fallbackDurationMs: outcome.durationMs,
    });
    if (outcome.timedOut) {
      structured.ok = false;
      structured.isError = true;
      structured.result = `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s).${outcome.treeTerminated !== true ? ' No se pudo confirmar la terminación del árbol de procesos.' : ''}`;
    } else if (outcome.truncated) {
      structured.ok = false;
      structured.isError = true;
      structured.result = 'La salida de Claude Code fue truncada por exceder el límite permitido.';
    }

    return {
      text:
        structured.result ||
        (structured.ok
          ? '(Claude Code completó sin salida de texto.)'
          : `Error en Claude Code (código ${String(structured.exitCode)}).`),
      structuredContent: structured,
      isError: structured.isError,
    };
  }

  const tools = [
    {
      name: 'claude_status',
      description:
        'Comprueba disponibilidad, versión CLI y estado de cuenta oficial de Claude Code sin consumir tokens.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const executable = getExecutable();
        if (!executable) {
          const structured = {
            ok: false,
            available: false,
            cliVersion: null,
            defaultModel: DEFAULT_MODEL,
          };
          return {
            text: 'Claude Code CLI no localizado en CLAUDE_BIN, ~/.local/bin/claude.exe ni PATH.',
            structuredContent: structured,
          };
        }

        const env = sanitizedEnv();
        const cwd = process.cwd();
        const versionRes = await runProcess({
          executable,
          args: ['--version'],
          cwd,
          env,
          timeoutMs: STATUS_TIMEOUT_MS,
        });
        const versionText = asNonEmptyString(versionRes.stdout);
        const cliVersion = versionRes.exitCode === 0 && !versionRes.truncated && !versionRes.timedOut &&
          versionText && /^\d+\.\d+\.\d+(?: \(Claude Code\))?$/.test(versionText) ? versionText : null;

        const auth = await readAuth(executable, cwd, 'read-only', env);
        const authenticated = auth.loggedIn === true && auth.authMethod === 'claude.ai';

        const structured = {
          ok: Boolean(cliVersion && authenticated),
          available: true,
          cliVersion,
          defaultModel: DEFAULT_MODEL,
        };

        return {
          text: structured.ok
            ? `Claude Code ${cliVersion} disponible. Modelo predeterminado: ${DEFAULT_MODEL}.`
            : 'Claude Code no pudo verificar la disponibilidad de la sesión.',
          structuredContent: structured,
        };
      },
    },
    {
      name: 'claude_ask',
      description:
        'Envía una consulta a Claude Code, exige una sesión claude.ai, retira credenciales heredadas del entorno y soporta --resume.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Carpeta de trabajo absoluta y real (sin symlinks).' },
          prompt: { type: 'string', minLength: 1, description: 'Instrucción enviada por stdin.' },
          model: { type: 'string', description: 'Modelo (por defecto claude-fable-5-2).' },
          sessionId: { type: 'string', description: 'ID de sesión previo para --resume.' },
          mode: { type: 'string', enum: ['read-only', 'plan', 'edit'], default: 'read-only' },
          maxTurns: { type: 'integer', minimum: 1, maximum: 50 },
          timeoutSec: { type: 'integer', minimum: 5, maximum: 600, default: 240 },
        },
        required: ['cwd', 'prompt'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        return executeClaudePrompt({
          cwd: args.cwd,
          prompt: args.prompt,
          model: args.model,
          sessionId: args.sessionId,
          mode: args.mode ?? 'read-only',
          maxTurns: args.maxTurns,
          timeoutSec: args.timeoutSec,
        });
      },
    },
    {
      name: 'claude_review',
      description:
        'Ejecuta una auditoría técnica estrictamente de solo lectura (P0/P1/P2 con archivo y línea) mediante Claude Code CLI.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Carpeta del repositorio a auditar (absoluta, sin symlinks).' },
          target: { type: 'string', description: 'Archivos, commit o alcance concreto a revisar.' },
          focus: { type: 'string', description: 'Aspectos prioritarios de revisión.' },
          model: { type: 'string', description: 'Modelo (por defecto claude-fable-5-2).' },
          sessionId: { type: 'string', description: 'ID de sesión previo para --resume.' },
          maxTurns: { type: 'integer', minimum: 1, maximum: 50 },
          timeoutSec: { type: 'integer', minimum: 5, maximum: 600, default: 240 },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        const target = args.target === undefined ? '' : String(args.target).trim();
        const focus = args.focus === undefined ? '' : String(args.focus).trim();
        if (target.includes('\0') || focus.includes('\0')) {
          throw new BridgeError('Los parámetros target y focus no pueden contener caracteres nulos.');
        }
        return executeClaudePrompt({
          cwd: args.cwd,
          prompt: buildReviewPrompt({ target, focus }),
          model: args.model,
          sessionId: args.sessionId,
          mode: 'read-only',
          maxTurns: args.maxTurns,
          timeoutSec: args.timeoutSec,
        });
      },
    },
    {
      name: 'claude_list_sessions',
      description:
        'Lista sesiones JSONL locales recientes de Claude Code para un cwd sin seguir enlaces simbólicos ni consumir tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Carpeta absoluta del proyecto.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        required: ['cwd'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        let limit = 20;
        if (args.limit !== undefined) {
          if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
            throw new BridgeError('limit debe ser un entero entre 1 y 100.');
          }
          limit = args.limit;
        }
        const listing = listClaudeSessionsForCwd({
          cwd: args.cwd,
          claudeHome,
          limit,
        });
        const sessionLines = listing.sessions.map(
          s => `- ${s.sessionId} · ${s.modifiedAt} · ${s.sizeBytes} B`,
        );
        return {
          text:
            listing.sessions.length > 0
              ? [
                  `${listing.sessions.length} sesión(es) locales encontradas (total: ${listing.total}):`,
                  ...sessionLines,
                ].join('\n')
              : 'No hay sesiones locales registradas para el proyecto.',
          structuredContent: {
            ok: true,
            ...listing,
          },
        };
      },
    },
  ];

  return createMcpStdioServer({
    name: 'claude-code-local',
    version: '0.1.0',
    instructions:
      'Servidor MCP local para Claude Code CLI: verifica una sesión claude.ai y retira credenciales del entorno. Los ajustes restantes del CLI pueden influir en proveedor y destino. Usa read-only por defecto y claude_list_sessions para obtener sessionId antes de --resume.',
    tools,
  });
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    (process.platform === 'win32' &&
      import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()));

if (isEntrypoint) {
  await startBridge('claude-code-local', createClaudeCodeMcpServer);
}
