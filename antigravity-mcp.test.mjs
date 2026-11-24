import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildAgyCliArgs,
  createAntigravityMcpServer,
  parseAgyJsonResult,
} from './antigravity-mcp-server.mjs';

const OK_JSON = JSON.stringify({
  conversation_id: '11111111-2222-4333-8444-555555555555',
  status: 'SUCCESS',
  response: 'MCP_AGY_OK',
  error: '',
  duration_seconds: 1.5,
  num_turns: 1,
  finished_reason: 'stop',
});
const QUOTA_JSON = JSON.stringify({
  conversation_id: '11111111-2222-4333-8444-555555555555',
  status: 'ERROR',
  response: '',
  error: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h9m37s.',
  duration_seconds: 0,
  num_turns: 1,
  finished_reason: 'error',
});

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'arconte-agy-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = {};
  for (const name of ['cwd', 'buzon', 'conversaciones', 'cerrojos']) {
    dirs[name] = join(root, name);
    mkdirSync(dirs[name]);
  }
  mkdirSync(join(dirs.cwd, '.git'));
  return dirs;
}

function call(server, name, args = {}) {
  return server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

function makeServer(dirs, runProcess, extra = {}) {
  return createAntigravityMcpServer({
    executable: 'agy.exe',
    env: { GEMINI_API_KEY: 'x', GOOGLE_API_KEY: 'y', GOOGLE_GENAI_USE_VERTEXAI: '1', PATH: 'p', LOCALAPPDATA: dirs.cwd },
    buzonDir: dirs.buzon,
    conversationsDir: dirs.conversaciones,
    probeCwd: dirs.cwd,
    lockDir: dirs.cerrojos,
    now: () => new Date('2026-11-24T00:05:09Z'),
    runProcess,
    ...extra,
  });
}

test('antigravity-local MCP: initialize, tools/list y consulta en modo plan sin claves heredadas', async t => {
  const dirs = sandbox(t);
  const calls = [];
  const server = makeServer(dirs, async params => {
    calls.push(params);
    if (params.args[0] === '--version') return { stdout: '1.5.14\n', stderr: '', exitCode: 0, durationMs: 5 };
    if (params.args[0] === 'models') {
      return { stdout: 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n', stderr: '', exitCode: 0, durationMs: 5 };
    }
    return { stdout: `${OK_JSON}\n`, stderr: '', exitCode: 0, durationMs: 1500 };
  });

  const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.serverInfo.name, 'antigravity-local');
  const list = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(list.result.tools.map(tool => tool.name), [
    'antigravity_status',
    'antigravity_models',
    'antigravity_ask',
    'antigravity_list_conversations',
    'buzon_list',
    'buzon_read',
    'buzon_send',
    'buzon_archive',
  ]);

  const status = await call(server, 'antigravity_status');
  assert.equal(status.result.structuredContent.cliVersion, '1.5.14');
  assert.equal(status.result.structuredContent.quota, 'no comprobada');
  assert.equal(calls.length, 1, 'sin probe no se envía ningún turno');

  const models = await call(server, 'antigravity_models');
  assert.deepEqual(models.result.structuredContent.models.map(m => m.id), ['gemini-4-neon-high', 'claude-opus-5-5-low']);

  const ask = await call(server, 'antigravity_ask', {
    cwd: dirs.cwd,
    prompt: 'Línea 1\n--mode accept-edits "comillas"',
    model: 'gemini-4-neon-high',
    conversationId: '11111111-2222-4333-8444-555555555555',
    timeoutSec: 30,
  });
  assert.equal(ask.result.isError, undefined);
  assert.equal(ask.result.structuredContent.result, 'MCP_AGY_OK');
  assert.equal(ask.result.structuredContent.durationMs, 1500);
  assert.equal(ask.result.structuredContent.quotaExhausted, false);
  const sent = calls.at(-1);
  assert.deepEqual(sent.args, [
    '--print=Línea 1\n--mode accept-edits "comillas"',
    '--output-format', 'json',
    '--mode', 'plan',
    '--print-timeout', '30s',
    '--model', 'gemini-4-neon-high',
    '--conversation', '11111111-2222-4333-8444-555555555555',
  ]);
  assert.equal(sent.timeoutMs, 45_000);
  assert.equal(sent.stdinText, undefined);
  assert.deepEqual(Object.keys(sent.env).sort(), ['LOCALAPPDATA', 'PATH']);
  assert.ok(!sent.args.includes('--dangerously-skip-permissions'));
  assert.equal(readdirSync(dirs.cerrojos).length, 0, 'plan no toma cerrojo');
});

test('Antigravity admite SUCCESS o estado vacío y rechaza otros estados incluso con respuesta y salida cero', () => {
  const parse = status => parseAgyJsonResult(JSON.stringify({ status, response: 'texto' }), '', 0, { mode: 'plan' });
  for (const status of ['SUCCESS', undefined, null, '', ' ']) {
    assert.equal(parse(status).ok, true);
  }
  for (const status of ['FAILED', 'CANCELLED', 'success', false, 0, {}]) {
    const result = parse(status);
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
  }
});

test('antigravity-local informa la cuota agotada y cuándo se restablece', async t => {
  const dirs = sandbox(t);
  const server = makeServer(dirs, async params =>
    params.args[0] === '--version'
      ? { stdout: '1.5.14', stderr: '', exitCode: 0, durationMs: 1 }
      : { stdout: QUOTA_JSON, stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}', exitCode: 3, durationMs: 90 });

  const ask = await call(server, 'antigravity_ask', { cwd: dirs.cwd, prompt: 'hola' });
  assert.equal(ask.result.isError, true);
  assert.equal(ask.result.structuredContent.quotaExhausted, true);
  assert.equal(ask.result.structuredContent.resetsIn, '1h9m37s');
  assert.match(ask.result.content[0].text, /cuota agotada.*1h9m37s.*buzon_send/);

  const status = await call(server, 'antigravity_status', { probe: true });
  assert.equal(status.result.structuredContent.ok, false);
  assert.equal(status.result.structuredContent.quota, 'agotada');
  assert.equal(status.result.structuredContent.resetsIn, '1h9m37s');

  // Un JSON de diagnóstico sin respuesta de turno no cuenta como éxito, ni una versión ilegible como CLI disponible.
  assert.equal(parseAgyJsonResult('{"level":"info","msg":"arranque"}', '', 0, { mode: 'plan' }).isError, true);
  const noVersion = makeServer(dirs, async () => ({ stdout: 'Usage of agy', stderr: '', exitCode: 0, durationMs: 1 }));
  assert.equal((await call(noVersion, 'antigravity_status')).result.structuredContent.cliVersion, null);
  assert.equal((await call(noVersion, 'antigravity_status')).result.structuredContent.ok, false);

  const parsed = parseAgyJsonResult('', 'fallo sin JSON', 1, { mode: 'plan' });
  assert.equal(parsed.isError, true);
  assert.equal(parsed.quotaExhausted, false);
  assert.equal(parsed.result, 'Antigravity no completó la consulta.');
});

test('antigravity-local rechaza entradas inválidas antes de ejecutar y serializa accept-edits', async t => {
  const dirs = sandbox(t);
  let invoked = 0;
  let lockSeen = 0;
  const server = makeServer(dirs, async params => {
    invoked++;
    lockSeen = readdirSync(dirs.cerrojos).length;
    params.onSpawn?.(process.pid);
    return { stdout: OK_JSON, stderr: '', exitCode: 0, durationMs: 1 };
  });
  const bad = [
    { cwd: dirs.cwd, prompt: 'x', model: '--dangerously-skip-permissions' },
    { cwd: dirs.cwd, prompt: 'x', conversationId: '../otro' },
    { cwd: dirs.cwd, prompt: 'x', mode: 'auto' },
    { cwd: dirs.cwd, prompt: 'x'.repeat(24_001) },
    { cwd: dirs.cwd, prompt: '"'.repeat(8_001) },
    { cwd: dirs.cwd, prompt: 'a\0b' },
    { cwd: dirs.cwd, prompt: 'x', timeoutSec: 601 },
    { cwd: 'relativa', prompt: 'x' },
    { cwd: join(dirs.cwd, 'no-existe'), prompt: 'x' },
  ];
  for (const args of bad) {
    const res = await call(server, 'antigravity_ask', args);
    assert.equal(res.result.isError, true, JSON.stringify(Object.keys(args)));
  }
  assert.equal(invoked, 0);
  assert.throws(() => buildAgyCliArgs({ prompt: 'x', mode: 'auto', timeoutSec: 5 }), /Modo inválido/);

  const edit = await call(server, 'antigravity_ask', { cwd: dirs.cwd, prompt: 'edita', mode: 'accept-edits' });
  assert.equal(edit.result.structuredContent.ok, true);
  assert.equal(lockSeen, 1, 'accept-edits ejecuta con el cerrojo tomado');
  assert.equal(readdirSync(dirs.cerrojos).length, 0, 'el cerrojo se libera al terminar');

  const scriptServer = makeServer(dirs, async () => { invoked++; }, { executable: join(dirs.cwd, 'agy.cmd') });
  const script = await call(scriptServer, 'antigravity_ask', { cwd: dirs.cwd, prompt: 'x' });
  assert.equal(script.result.isError, true);
  assert.equal(invoked, 1);
});

test('Antigravity conserva el cerrojo de accept-edits y bloquea el reintento tras un timeout sin terminación confirmada', async t => {
  const dirs = sandbox(t);
  let writes = 0;
  const server = makeServer(dirs, async ({ onSpawn }) => {
    writes++;
    onSpawn(process.pid);
    return { stdout: OK_JSON, stderr: '', exitCode: 124, timedOut: true, treeTerminated: false };
  });
  const write = () => call(server, 'antigravity_ask', { cwd: dirs.cwd, prompt: 'Editar', mode: 'accept-edits' });
  const timeout = await write();
  assert.equal(timeout.result.isError, true);
  assert.match(timeout.result.content[0].text, /terminación del árbol/);
  const [name] = readdirSync(dirs.cerrojos);
  assert.match(name, /\.lock$/);
  const path = join(dirs.cerrojos, name);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.unterminatedTree, true);
  assert.equal(record.childPid, process.pid);
  const retry = await write();
  assert.equal(retry.result.isError, true);
  assert.match(retry.result.content[0].text, /escritor previo.*terminación del árbol.*limpieza manual/i);
  assert.ok(retry.result.content[0].text.includes(path));

  // Un subdirectorio dentro del mismo worktree (.git) comparte exactamente el mismo cerrojo.
  const dirs2 = sandbox(t);
  const subDir2 = join(dirs2.cwd, 'subpkg');
  mkdirSync(subDir2);
  let subWrites = 0;
  const subServer = makeServer(dirs2, async ({ onSpawn }) => {
    subWrites++;
    onSpawn(process.pid);
    return { stdout: OK_JSON, stderr: '', exitCode: 124, timedOut: true };
  });
  const subTimeout = await call(subServer, 'antigravity_ask', { cwd: subDir2, prompt: 'Editar', mode: 'accept-edits' });
  assert.equal(subTimeout.result.isError, true);
  const retryRoot = await call(subServer, 'antigravity_ask', { cwd: dirs2.cwd, prompt: 'Editar', mode: 'accept-edits' });
  assert.equal(retryRoot.result.isError, true);
  assert.match(retryRoot.result.content[0].text, /limpieza manual/);
  assert.equal(subWrites, 1);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record);
});

test('antigravity-local lista solo conversaciones regulares de la CLI', async t => {
  const dirs = sandbox(t);
  writeFileSync(join(dirs.conversaciones, '11111111-2222-4333-8444-555555555555.db'), 'a');
  writeFileSync(join(dirs.conversaciones, 'no-es-uuid.db'), 'b');
  writeFileSync(join(dirs.conversaciones, '11111111-2222-4333-8444-555555555555.db-wal'), 'c');
  const server = makeServer(dirs, async () => { throw new Error('no debe ejecutar la CLI'); });
  const res = await call(server, 'antigravity_list_conversations', { limit: 5 });
  assert.deepEqual(res.result.structuredContent.conversaciones.map(c => c.conversationId), ['11111111-2222-4333-8444-555555555555']);
  const invalid = await call(server, 'antigravity_list_conversations', { limit: 0 });
  assert.equal(invalid.result.isError, true);
});

test('buzón tripartito: enviar, listar, leer y archivar sin sobrescribir ni salir de sus carpetas', async t => {
  const dirs = sandbox(t);
  const server = makeServer(dirs, async () => { throw new Error('el buzón no ejecuta la CLI'); });
  const message = {
    de: 'claude-code',
    para: 'codex',
    tipo: 'aviso',
    asunto: 'Cadena de mando: ¡URGENTE!',
    cuerpo: 'Primera línea\r\nSegunda línea',
    worktree: 'app-v8',
  };

  const sent = await call(server, 'buzon_send', message);
  const id = '20261123-1805-claude-code-cadena-de-mando-urgente';
  assert.equal(sent.result.structuredContent.id, id);
  const stored = readFileSync(join(dirs.buzon, 'para-codex', `${id}.md`), 'utf8');
  assert.equal(stored, [
    `id: ${id}`,
    'de: claude-code',
    'para: codex',
    'fecha: 2026-11-23T18:05:09-06:00',
    'tipo: aviso',
    'worktree: app-v8',
    'archivos: ninguno',
    'responde_a: ninguno',
    '',
    'Primera línea\nSegunda línea',
    '',
  ].join('\n'));

  const duplicate = await call(server, 'buzon_send', message);
  assert.equal(duplicate.result.isError, true);
  assert.match(duplicate.result.content[0].text, /Ya existe/);

  for (const invalid of [
    { ...message, para: 'claude-code' },
    { ...message, para: 'ivan' },
    { ...message, tipo: 'orden' },
    { ...message, asunto: '¡¡¡' },
    { ...message, asunto: 'otro', worktree: 'a\nid: falso' },
    { ...message, asunto: 'otro', cuerpo: 'x'.repeat(70_000) },
  ]) {
    assert.equal((await call(server, 'buzon_send', invalid)).result.isError, true);
  }
  assert.deepEqual(readdirSync(join(dirs.buzon, 'para-codex')), [`${id}.md`]);

  writeFileSync(join(dirs.buzon, 'para-codex', 'notas.txt'), 'no es un mensaje');
  const listed = await call(server, 'buzon_list', { buzon: 'codex' });
  assert.deepEqual(listed.result.structuredContent.mensajes.map(m => m.id), [id]);
  assert.equal((await call(server, 'buzon_list', { buzon: 'antigravity' })).result.structuredContent.total, 0);

  const read = await call(server, 'buzon_read', { buzon: 'codex', id });
  assert.equal(read.result.structuredContent.texto, stored);
  for (const badId of ['../para-codex/' + id, 'notas.txt', '..', `${id}/../x`]) {
    assert.equal((await call(server, 'buzon_read', { buzon: 'codex', id: badId })).result.isError, true, badId);
  }
  assert.equal((await call(server, 'buzon_read', { buzon: '../cwd', id })).result.isError, true);

  const archived = await call(server, 'buzon_archive', { buzon: 'codex', id });
  assert.equal(archived.result.structuredContent.a, 'archivo');
  assert.ok(existsSync(join(dirs.buzon, 'archivo', `${id}.md`)));
  assert.ok(!existsSync(join(dirs.buzon, 'para-codex', `${id}.md`)));
  assert.equal((await call(server, 'buzon_read', { buzon: 'archivo', id })).result.structuredContent.texto, stored);

  // Un id ya archivado no puede reutilizarse, tampoco hacia otro destinatario.
  assert.equal((await call(server, 'buzon_send', message)).result.isError, true);
  assert.equal((await call(server, 'buzon_send', { ...message, para: 'antigravity' })).result.isError, true);
  assert.deepEqual(readdirSync(join(dirs.buzon, 'para-codex')), ['notas.txt'], 'no quedan temporales ni mensajes parciales');

  // Si otro proceso deja un mensaje con ese id, archivar no sobrescribe el ya archivado.
  writeFileSync(join(dirs.buzon, 'para-codex', `${id}.md`), 'otro contenido');
  const collision = await call(server, 'buzon_archive', { buzon: 'codex', id });
  assert.equal(collision.result.isError, true);
  assert.ok(existsSync(join(dirs.buzon, 'para-codex', `${id}.md`)), 'el mensaje pendiente se conserva');
  assert.equal(readFileSync(join(dirs.buzon, 'archivo', `${id}.md`), 'utf8'), stored, 'el archivado previo queda intacto');

  // La lectura queda acotada y el listado omite nombres que luego no podrían leerse.
  mkdirSync(join(dirs.buzon, 'para-claude'));
  writeFileSync(join(dirs.buzon, 'para-claude', '20261123-1900-codex-grande.md'), 'x'.repeat(256 * 1024 + 1));
  writeFileSync(join(dirs.buzon, 'para-claude', `20261123-1900-codex-${'a'.repeat(110)}.md`), 'largo');
  assert.equal((await call(server, 'buzon_read', { buzon: 'claude-code', id: '20261123-1900-codex-grande' })).result.isError, true);
  assert.deepEqual(
    (await call(server, 'buzon_list', { buzon: 'claude-code' })).result.structuredContent.mensajes.map(m => m.id),
    ['20261123-1900-codex-grande'],
  );
  assert.equal((await call(server, 'buzon_archive', { buzon: 'archivo', id })).result.isError, true);
});
