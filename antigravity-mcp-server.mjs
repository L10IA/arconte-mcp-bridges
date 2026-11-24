import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultRunProcess } from './claude-code-mcp-server.mjs';
import {
  assertNativeExecutable,
  assertPlainCwd,
  connectionServer,
  resolveExecutable,
  BridgeError,
  buildCliEnv,
  withCwdWriteLock,
} from './mcp-stdio.mjs';
import { projectServer, startBridge } from './bridge-policy.mjs';

const DEFAULT_TIMEOUT_SEC = 240;
const MAX_TIMEOUT_SEC = 600;
const STATUS_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_SEC = 60;
// El prompt viaja como un único argumento (`--print=<texto>`); Windows limita la línea de órdenes a 32 767 caracteres.
const MAX_PROMPT_CHARS = 24_000;
// Cada comilla o barra invertida puede duplicarse al escapar el argumento en Windows.
const escapedPromptLength = prompt => prompt.length + 2 * (prompt.match(/["\\]/g)?.length ?? 0);
const CLI_VERSION = /^\d+\.\d+\.\d+$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const VALID_MODES = new Set(['plan', 'accept-edits']);
const AGENTS = ['antigravity', 'claude-code', 'codex'];
const AGENT_FOLDERS = { antigravity: 'para-antigravity', 'claude-code': 'para-claude', codex: 'para-codex' };
const ARCHIVE_FOLDER = 'archivo';
const MESSAGE_TYPES = ['encargo', 'pregunta', 'entrega', 'bloqueo', 'acuse', 'aviso'];
const MESSAGE_NAME = /^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseTimeoutSec(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > MAX_TIMEOUT_SEC) {
    throw new BridgeError(`timeoutSec debe ser un entero entre 5 y ${MAX_TIMEOUT_SEC}.`);
  }
  return value;
}

function parseLimit(value, fallback = 20) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new BridgeError('limit debe ser un entero entre 1 y 100.');
  }
  return value;
}

function singleLine(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\r\n\0]/.test(value)) {
    throw new BridgeError(`${label} debe ser una sola línea de texto de hasta 500 caracteres.`);
  }
  return value.trim();
}

export function buildAgyCliArgs({ prompt, mode, model, conversationId, timeoutSec }) {
  if (!VALID_MODES.has(mode)) {
    throw new BridgeError('Modo inválido. Usa plan o accept-edits.');
  }
  const args = [`--print=${prompt}`, '--output-format', 'json', '--mode', mode, '--print-timeout', `${timeoutSec}s`];
  if (model) args.push('--model', model);
  if (conversationId) args.push('--conversation', conversationId);
  return args;
}

export function parseAgyJsonResult(stdout, stderr, exitCode, { mode, model = null, fallbackConversationId = null, fallbackDurationMs = 0 }) {
  const out = String(stdout ?? '').trim();
  const err = String(stderr ?? '').trim();
  let parsed = {};
  for (const candidate of [out, ...out.split(/\r?\n/).reverse()]) {
    const line = candidate.trim();
    if (!line.startsWith('{')) continue;
    try {
      parsed = asObject(JSON.parse(line));
      if (Object.keys(parsed).length > 0) break;
    } catch {
      /* Probar la siguiente línea candidata. */
    }
  }
  // La CLI devuelve SUCCESS en los turnos correctos y también se admite un estado ausente o vacío.
  const status = parsed.status ?? '';
  const validStatus = status === 'SUCCESS' || (typeof status === 'string' && status.trim() === '');
  const errorText = asNonEmptyString(parsed.error);
  const response = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  // Sin el campo response no hay resultado de un turno, aunque el proceso salga con código cero.
  const isError = exitCode !== 0 || !validStatus || Boolean(errorText) || typeof parsed.response !== 'string';
  const diagnostic = `${errorText ?? ''}\n${err}`;
  const quotaExhausted = isError && /RESOURCE_EXHAUSTED|quota reached/i.test(diagnostic);
  const resets = /Resets in ([0-9]+h)?([0-9]+m)?([0-9]+s)?/i.exec(diagnostic);
  return {
    ok: !isError,
    conversationId: typeof parsed.conversation_id === 'string' && UUID.test(parsed.conversation_id) ? parsed.conversation_id : fallbackConversationId,
    model,
    mode,
    status: validStatus ? asNonEmptyString(status) : 'ERROR',
    result: isError ? (quotaExhausted ? 'Cuota de Antigravity agotada.' : 'Antigravity no completó la consulta.') : response,
    numTurns: typeof parsed.num_turns === 'number' && Number.isFinite(parsed.num_turns) ? parsed.num_turns : null,
    durationMs:
      typeof parsed.duration_seconds === 'number' && Number.isFinite(parsed.duration_seconds) && parsed.duration_seconds > 0
        ? Math.round(parsed.duration_seconds * 1000)
        : fallbackDurationMs,
    quotaExhausted,
    resetsIn: quotaExhausted && resets && resets[0].length > 'Resets in '.length ? resets[0].slice('Resets in '.length) : null,
    isError,
    exitCode,
  };
}

/** Hora de Ciudad de México (UTC−06:00 fijo desde 2022) para nombres y encabezados del buzón. */
function mexicoCityStamp(now) {
  const shifted = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const pad = value => String(value).padStart(2, '0');
  const date = `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}`;
  const iso = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}-06:00`;
  return { prefix: `${date}-${time}`, iso };
}

function slugify(value) {
  const slug = String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (!slug) throw new BridgeError('asunto debe contener letras o números.');
  return slug;
}

function createMailbox(policy) {
  const identity = policy.mailboxAs;
  const archiveFolder = agent => `archivo-${agent}`;
  function folderPath(folder, { create = false } = {}) {
    const base = policy.mailboxRoot(create);
    if (!base) return null;
    const path = join(base, folder);
    if (!existsSync(path)) {
      if (!create) return null;
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BridgeError(`La carpeta ${folder} del buzón no es un directorio real.`);
    }
    return path;
  }

  function folderFor(box, { allowArchive = false } = {}) {
    if (allowArchive && box === ARCHIVE_FOLDER) return archiveFolder(identity);
    if (box !== identity) throw new BridgeError('Esta instancia solo tiene acceso a su propia bandeja.');
    return AGENT_FOLDERS[identity];
  }

  function messageName(id) {
    if (typeof id !== 'string') throw new BridgeError('id debe ser el nombre de un mensaje del buzón.');
    const name = id.trim().endsWith('.md') ? id.trim() : `${id.trim()}.md`;
    if (name.length > 120 || !MESSAGE_NAME.test(name)) {
      throw new BridgeError('id no tiene el formato AAAAMMDD-HHMM-<de>-<asunto>.');
    }
    return name;
  }

  function plainFile(path) {
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new BridgeError('El mensaje no existe en ese buzón.');
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) throw new BridgeError('El mensaje no es un archivo regular.');
    return stat;
  }

  function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
  }

  function readMessage(path) {
    const expected = plainFile(path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, expected)) {
        throw new BridgeError('El mensaje cambió durante la lectura.');
      }
      if (opened.size > MAX_READ_BYTES) throw new BridgeError('El mensaje excede el tamaño máximo de lectura.');
      const buffer = Buffer.alloc(Number(opened.size));
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!count) break;
        bytes += count;
      }
      if (bytes !== buffer.length || !sameFile(opened, fstatSync(fd, { bigint: true }))) {
        throw new BridgeError('El mensaje cambió durante la lectura.');
      }
      return { buffer, snapshot: opened };
    } finally { closeSync(fd); }
  }

  function publishMessage(target, data, duplicate) {
    const pending = join(dirname(target), '.' + randomUUID() + '.tmp');
    const fd = openSync(pending, 'wx', 0o600);
    try {
      try { writeFileSync(fd, data); } finally { closeSync(fd); }
      try { linkSync(pending, target); }
      catch (error) {
        if (error.code === 'EEXIST') throw new BridgeError(duplicate);
        throw error;
      }
    } finally { unlinkSync(pending); }
  }

  return {
    list(box, limit) {
      const folder = folderFor(box, { allowArchive: true });
      const path = folderPath(folder);
      if (!path) return { buzon: box, carpeta: folder, mensajes: [], total: 0 };
      const all = [];
      for (const name of readdirSync(path)) {
        if (name.length > 120 || !MESSAGE_NAME.test(name)) continue;
        let stat;
        try { stat = lstatSync(join(path, name)); } catch { continue; }
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) continue;
        all.push({ id: name.slice(0, -3), modificado: new Date(stat.mtimeMs).toISOString(), bytes: stat.size });
      }
      all.sort((a, b) => b.id.localeCompare(a.id));
      return { buzon: box, carpeta: folder, mensajes: all.slice(0, limit), total: all.length };
    },

    read(box, id) {
      const folder = folderFor(box, { allowArchive: true });
      const path = folderPath(folder);
      if (!path) throw new BridgeError('El mensaje no existe en ese buzón.');
      const name = messageName(id);
      const { buffer } = readMessage(join(path, name));
      return { buzon: box, id: name.slice(0, -3), bytes: buffer.length, texto: buffer.toString('utf8') };
    },

    send({ de = identity, para, tipo, asunto, cuerpo, worktree, archivos, respondeA }, now) {
      if (de !== identity) throw new BridgeError('El remitente no coincide con la identidad de esta instancia.');
      if (!AGENTS.includes(de) || !AGENTS.includes(para) || de === para) {
        throw new BridgeError(`de y para deben ser dos agentes distintos entre ${AGENTS.join(', ')}.`);
      }
      if (!MESSAGE_TYPES.includes(tipo)) throw new BridgeError(`tipo inválido; usa ${MESSAGE_TYPES.join(', ')}.`);
      if (typeof cuerpo !== 'string' || !cuerpo.trim() || cuerpo.includes('\0')) {
        throw new BridgeError('cuerpo es obligatorio y no puede contener caracteres nulos.');
      }
      const reply = singleLine(respondeA, 'responde_a', 'ninguno');
      const stamp = mexicoCityStamp(now);
      const id = `${stamp.prefix}-${de}-${slugify(asunto)}`;
      const text = [
        `id: ${id}`,
        `de: ${de}`,
        `para: ${para}`,
        `fecha: ${stamp.iso}`,
        `tipo: ${tipo}`,
        `worktree: ${singleLine(worktree, 'worktree', 'ninguno')}`,
        `archivos: ${singleLine(archivos, 'archivos', 'ninguno')}`,
        `responde_a: ${reply}`,
        '',
        cuerpo.replace(/\r\n/g, '\n').trimEnd(),
        '',
      ].join('\n');
      if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
        throw new BridgeError('El mensaje excede el tamaño máximo del buzón (64 KiB).');
      }
      const duplicate = 'Ya existe un mensaje con ese id. Cambia el asunto o espera un minuto.';
      // El id debe ser único en todo el buzón: dos mensajes con el mismo id no podrían archivarse.
      for (const other of [...Object.values(AGENT_FOLDERS), ...AGENTS.map(archiveFolder)]) {
        const existing = folderPath(other);
        if (existing && existsSync(join(existing, `${id}.md`))) throw new BridgeError(duplicate);
      }
      const folder = folderPath(AGENT_FOLDERS[para], { create: true });
      publishMessage(join(folder, id + '.md'), text, duplicate);
      return { id, buzon: para, carpeta: AGENT_FOLDERS[para], bytes: Buffer.byteLength(text, 'utf8') };
    },

    archive(box, id) {
      const folder = folderFor(box);
      const source = folderPath(folder);
      if (!source) throw new BridgeError('El mensaje no existe en ese buzón.');
      const name = messageName(id);
      const original = join(source, name);
      const { buffer, snapshot } = readMessage(original);
      const target = join(folderPath(archiveFolder(identity), { create: true }), name);
      publishMessage(target, buffer, 'El archivo ya contiene un mensaje con ese id.');
      let sourceCleanupPending = false;
      try {
        const current = lstatSync(original, { bigint: true, throwIfNoEntry: false });
        if (current && current.isFile() && current.nlink === 1n && sameFile(current, snapshot)) unlinkSync(original);
        else sourceCleanupPending = Boolean(current);
      } catch { sourceCleanupPending = true; }
      return { id: name.slice(0, -3), de: folder, a: ARCHIVE_FOLDER, sourceCleanupPending };
    },
  };
}


export function createAntigravityMcpServer(options = {}) {
  const { policy } = options;
  if (!policy) return connectionServer('antigravity-local');
  const baseEnv = options.env ?? process.env;
  const homeDirectory = options.homeDir ?? homedir();
  const localAppData = asNonEmptyString(baseEnv.LOCALAPPDATA) ?? join(homeDirectory, 'AppData', 'Local');
  const mailbox = createMailbox(policy);
  const probeCwd = policy.root;
  const now = options.now ?? (() => new Date());
  const resolveBinary =
    options.resolveExecutable ??
    (() => policy.installedExecutable(resolveExecutable('AGY_BIN', [join(localAppData, 'agy', 'bin', 'agy.exe')], ['agy.exe', 'agy'])));
  const runProcess =
    options.runProcess ??
    (params => defaultRunProcess({ ...params, spawnProcess: options.spawnProcess, terminate: options.terminateProcessTree }));

  const sanitizedEnv = () => buildCliEnv(baseEnv);
  const getExecutable = () => {
    const executable = options.executable ?? resolveBinary();
    return executable ? assertNativeExecutable(executable) : null;
  };
  const requireExecutable = () => {
    const executable = getExecutable();
    if (!executable) throw new BridgeError('No se encontró agy.exe (ni en AGY_BIN, %LOCALAPPDATA%/agy/bin ni PATH).');
    return executable;
  };

  async function executePrompt({ cwd, prompt, model, conversationId, mode = 'plan', timeoutSec, recordSession = true }) {
    const plainCwd = assertPlainCwd(cwd);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
      throw new BridgeError('El parámetro prompt es obligatorio y no puede contener caracteres nulos.');
    }
    if (escapedPromptLength(prompt) > MAX_PROMPT_CHARS) {
      throw new BridgeError(`prompt excede ${MAX_PROMPT_CHARS} caracteres (cada comilla o barra invertida cuenta por tres); deja el detalle en un mensaje del buzón y cítalo por su id.`);
    }
    if (!VALID_MODES.has(mode)) throw new BridgeError('Modo inválido. Valores permitidos: plan, accept-edits.');
    if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model))) {
      throw new BridgeError('model inválido; usa un identificador devuelto por antigravity_models.');
    }
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !UUID.test(conversationId))) {
      throw new BridgeError('conversationId debe ser un UUID válido.');
    }
    const seconds = parseTimeoutSec(timeoutSec);
    const executable = requireExecutable();
    const args = buildAgyCliArgs({ prompt, mode, model, conversationId, timeoutSec: seconds });
    const env = sanitizedEnv();
    // El CLI aplica su propio límite; el del puente añade margen para terminar el árbol si no responde.
    const timeoutMs = seconds * 1000 + 15_000;
    const run = async lock => {
      if (recordSession) policy.prepareSession('antigravity');
      const outcome = await runProcess({ executable, args, cwd: policy.authorize(plainCwd), env, timeoutMs, onSpawn: lock?.registerChild });
      if (outcome.timedOut && outcome.treeTerminated !== true) lock?.markTreeUnterminated?.();
      return outcome;
    };
    const outcome = mode === 'accept-edits'
      ? await withCwdWriteLock(policy.root, 'antigravity-local', run, options.lockDir ?? policy.lockDirectory())
      : await run();

    const structured = parseAgyJsonResult(outcome.stdout, outcome.stderr, outcome.exitCode, {
      mode,
      model: model ?? null,
      fallbackConversationId: conversationId ?? null,
      fallbackDurationMs: outcome.durationMs ?? 0,
    });
    if (outcome.timedOut) {
      structured.ok = false;
      structured.isError = true;
      structured.result = `Tiempo de espera agotado (${seconds}s).${outcome.treeTerminated !== true ? ' No se pudo confirmar la terminación del árbol de procesos.' : ''}`;
    } else if (outcome.truncated) {
      structured.ok = false;
      structured.isError = true;
      structured.result = 'La salida de Antigravity fue truncada por exceder el límite permitido.';
    }
    return {
      text: structured.quotaExhausted
        ? `Antigravity no está disponible: cuota agotada${structured.resetsIn ? ` (se restablece en ${structured.resetsIn})` : ''}. Deja el mensaje en el buzón con buzon_send.`
        : structured.result || (structured.ok ? '(Antigravity completó sin salida de texto.)' : `Error en Antigravity (código ${String(structured.exitCode)}).`),
      structuredContent: structured,
      isError: structured.isError,
    };
  }

  const tools = [
    {
      name: 'antigravity_status',
      description:
        'Comprueba la CLI de Antigravity (agy.exe) y su versión sin consumir cuota. Con probe: true envía además un turno mínimo en modo plan para saber si hay cuota disponible o cuándo se restablece.',
      inputSchema: {
        type: 'object',
        properties: { probe: { type: 'boolean', default: false } },
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        if (args.probe !== undefined && typeof args.probe !== 'boolean') throw new BridgeError('probe debe ser booleano.');
        const executable = getExecutable();
        if (!executable) {
          return {
            text: 'Antigravity CLI no localizada en AGY_BIN, %LOCALAPPDATA%/agy/bin ni PATH.',
            structuredContent: { ok: false, available: false, cliVersion: null, quota: 'desconocida', quotaExhausted: null, resetsIn: null },
          };
        }
        const versionRes = await runProcess({ executable, args: ['--version'], cwd: policy.authorize(probeCwd), env: sanitizedEnv(), timeoutMs: STATUS_TIMEOUT_MS });
        const versionText = versionRes.exitCode === 0 && !versionRes.truncated && !versionRes.timedOut ? asNonEmptyString(versionRes.stdout) : null;
        const cliVersion = versionText && CLI_VERSION.test(versionText) ? versionText : null;
        let quota = 'no comprobada';
        let quotaExhausted = null;
        let resetsIn = null;
        if (args.probe === true && cliVersion) {
          const probe = await executePrompt({
            cwd: probeCwd,
            prompt: 'Responde solo con la palabra OK. No uses herramientas.',
            mode: 'plan',
            timeoutSec: PROBE_TIMEOUT_SEC,
            recordSession: false,
          });
          quotaExhausted = probe.structuredContent.quotaExhausted;
          resetsIn = probe.structuredContent.resetsIn;
          quota = quotaExhausted ? 'agotada' : probe.structuredContent.ok ? 'disponible' : 'error';
        }
        return {
          text: [
            cliVersion ? `Antigravity CLI ${cliVersion} localizada.` : 'Antigravity CLI localizada, pero no respondió a --version.',
            `Cuota: ${quota}${resetsIn ? ` (se restablece en ${resetsIn})` : ''}.`,
          ].join('\n'),
          structuredContent: { ok: Boolean(cliVersion) && quotaExhausted !== true && quota !== 'error', available: true, cliVersion, quota, quotaExhausted, resetsIn },
        };
      },
    },
    {
      name: 'antigravity_models',
      description: 'Lista los modelos que ofrece la CLI de Antigravity para la cuenta activa (sin consumir cuota).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const res = await runProcess({ executable: requireExecutable(), args: ['models'], cwd: policy.authorize(probeCwd), env: sanitizedEnv(), timeoutMs: STATUS_TIMEOUT_MS });
        if (res.exitCode !== 0 || res.truncated || res.timedOut) throw new BridgeError('No se pudo leer la lista de modelos de Antigravity.');
        const models = String(res.stdout ?? '')
          .split(/\r?\n/)
          .map(line => line.split('\t'))
          .filter(parts => parts.length >= 2 && MODEL_ID.test(parts[0].trim()))
          .map(parts => ({ id: parts[0].trim(), nombre: parts.slice(1).join(' ').trim() }));
        return {
          text: models.length > 0 ? models.map(m => `- ${m.id} · ${m.nombre}`).join('\n') : 'La CLI no devolvió modelos.',
          structuredContent: { ok: models.length > 0, models },
        };
      },
    },
    {
      name: 'antigravity_ask',
      description:
        'Envía una consulta a Antigravity mediante su CLI oficial con la sesión del usuario y sin claves de API heredadas. Usa plan por defecto. El modo accept-edits toma el cerrojo de escritura de toda la raíz autorizada. Si la cuota está agotada lo indica (quotaExhausted, resetsIn).',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Carpeta de trabajo absoluta y real (sin symlinks).' },
          prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS, description: 'Instrucción para Antigravity.' },
          model: { type: 'string', description: 'Identificador devuelto por antigravity_models (opcional).' },
          conversationId: { type: 'string', description: 'UUID registrado por este puente para el proyecto autorizado.' },
          mode: { type: 'string', enum: ['plan', 'accept-edits'], default: 'plan' },
          timeoutSec: { type: 'integer', minimum: 5, maximum: MAX_TIMEOUT_SEC, default: DEFAULT_TIMEOUT_SEC },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        return executePrompt({
          cwd: args.cwd,
          prompt: args.prompt,
          model: args.model,
          conversationId: args.conversationId,
          mode: args.mode ?? 'plan',
          timeoutSec: args.timeoutSec,
        });
      },
    },
    {
      name: 'antigravity_list_conversations',
      description:
        'Lista las conversaciones registradas por este puente de Antigravity para el proyecto autorizado. Permite reanudarlas por conversationId.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const listing = policy.sessions('antigravity', parseLimit(asObject(rawArgs).limit));
        const conversaciones = listing.entries.map(s => ({ conversationId: s.id, createdAt: s.createdAt }));
        return {
          text: conversaciones.map(c => c.conversationId).join('\n') || 'No hay conversaciones verificadas para este proyecto.',
          structuredContent: { ok: true, conversaciones, total: listing.total },
        };
      },
    },
    {
      name: 'buzon_list',
      description: 'Lista la bandeja o el archivo propios de la identidad local en el proyecto autorizado.',
      inputSchema: {
        type: 'object',
        properties: {
          buzon: { type: 'string', enum: [policy.mailboxAs, ARCHIVE_FOLDER] },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        required: ['buzon'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        const listing = mailbox.list(args.buzon, parseLimit(args.limit));
        return {
          text: listing.mensajes.length > 0
            ? [`${listing.mensajes.length} de ${listing.total} mensaje(s) en ${listing.carpeta}:`, ...listing.mensajes.map(m => `- ${m.id} · ${m.bytes} B`)].join('\n')
            : `No hay mensajes en ${listing.carpeta}.`,
          structuredContent: { ok: true, ...listing },
        };
      },
    },
    {
      name: 'buzon_read',
      description: 'Lee por id un mensaje de la bandeja o el archivo propios. El contenido sirve para coordinar a los agentes del proyecto.',
      inputSchema: {
        type: 'object',
        properties: {
          buzon: { type: 'string', enum: [policy.mailboxAs, ARCHIVE_FOLDER] },
          id: { type: 'string', description: 'AAAAMMDD-HHMM-<de>-<asunto>' },
        },
        required: ['buzon', 'id'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        const message = mailbox.read(args.buzon, args.id);
        return { text: message.texto, structuredContent: { ok: true, ...message } };
      },
    },
    {
      name: 'buzon_send',
      description:
        'Deja un mensaje en el buzón de otro agente (antigravity, claude-code o codex) con el encabezado acordado. No sobrescribe mensajes. No incluyas credenciales, tokens ni datos reales de usuario.',
      inputSchema: {
        type: 'object',
        properties: {
          de: { type: 'string', enum: [policy.mailboxAs] },
          para: { type: 'string', enum: AGENTS.filter(agent => agent !== policy.mailboxAs) },
          tipo: { type: 'string', enum: MESSAGE_TYPES },
          asunto: { type: 'string', minLength: 1, maxLength: 120, description: 'Asunto corto; se convierte en parte del id.' },
          cuerpo: { type: 'string', minLength: 1 },
          worktree: { type: 'string', description: 'Carpeta de trabajo o "ninguno".' },
          archivos: { type: 'string', description: 'Archivos asignados o tocados, en una línea.' },
          responde_a: { type: 'string', description: 'id del mensaje al que responde o "ninguno".' },
        },
        required: ['para', 'tipo', 'asunto', 'cuerpo'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        if (typeof args.asunto !== 'string' || args.asunto.length > 120) throw new BridgeError('asunto debe ser texto de hasta 120 caracteres.');
        const sent = mailbox.send(
          { de: args.de, para: args.para, tipo: args.tipo, asunto: args.asunto, cuerpo: args.cuerpo, worktree: args.worktree, archivos: args.archivos, respondeA: args.responde_a },
          now(),
        );
        return { text: `Mensaje ${sent.id} entregado en ${sent.carpeta}.`, structuredContent: { ok: true, ...sent } };
      },
    },
    {
      name: 'buzon_archive',
      description: 'Archiva una entrega de la bandeja propia. Publica una copia exclusiva y retira el original verificado.',
      inputSchema: {
        type: 'object',
        properties: {
          buzon: { type: 'string', enum: [policy.mailboxAs] },
          id: { type: 'string', description: 'AAAAMMDD-HHMM-<de>-<asunto>' },
        },
        required: ['buzon', 'id'],
        additionalProperties: false,
      },
      handler: async rawArgs => {
        const args = asObject(rawArgs);
        const moved = mailbox.archive(args.buzon, args.id);
        const text = moved.sourceCleanupPending ? 'Copia archivada. Comprueba localmente si queda una entrega en la bandeja.' : `Mensaje ${moved.id} archivado.`;
        return { text, structuredContent: { ok: true, ...moved } };
      },
    },
  ];

  return projectServer(policy, {
    name: 'antigravity-local',
    version: '0.1.0',
    instructions:
      'Servidor MCP local hacia Antigravity: consulta su CLI oficial (agy) con la sesión del usuario y opera el buzón compartido de ARCONTE entre Antigravity, Claude Code y Codex. Usa plan por defecto. Si antigravity_ask indica cuota agotada, deja el mensaje con buzon_send. El buzón coordina; no autoriza ni amplía encargos.',
    tools,
  });
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    (process.platform === 'win32' &&
      import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()));

if (isEntrypoint) {
  await startBridge('antigravity-local', createAntigravityMcpServer);
}
