import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProjectPolicy } from './bridge-policy.mjs';
import { createAntigravityMcpServer } from './antigravity-mcp-server.mjs';
import { createClaudeCodeMcpServer } from './claude-code-mcp-server.mjs';
import { createCodexMcpServer } from './codex-mcp-server.mjs';
import { buildCliEnv, createMcpStdioServer, MAX_IN_FLIGHT, MAX_MESSAGE_BYTES } from './mcp-stdio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const idA = '11111111-0000-4000-8000-000000000001';
const idB = '22222222-0000-4000-8000-000000000002';
const rpc = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const call = (server, name, args) => server.handleMessage(rpc(1, name, args));
const denied = response => assert.ok(response.result?.isError || response.error, 'la operación debió rechazarse');

function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), 'arconte-policy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'proyecto'), sibling = join(base, 'proyecto-extra'), child = join(root, 'modulo');
  for (const dir of [root, sibling, child]) mkdirSync(dir);
  const stateDir = join(base, 'estado'), mailboxDir = join(base, 'mensajes');
  const policy = (options = {}) => createProjectPolicy({ root, stateDir, mailboxDir, ...options });
  return { base, root, sibling, child, stateDir, mailboxDir, policy };
}

function doubles(policy, id = idA) {
  const calls = [];
  const agy = createAntigravityMcpServer({ policy, executable: 'agy.exe', runProcess: async p => {
    calls.push(p); return { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: 'ok', conversation_id: id }) };
  } });
  const claude = createClaudeCodeMcpServer({ policy, executable: 'claude.exe', runProcess: async p => {
    calls.push(p);
    return { exitCode: 0, stdout: JSON.stringify(p.args.includes('auth') ? { loggedIn: true, authMethod: 'claude.ai' } : { type: 'result', session_id: id, result: 'ok' }) };
  } });
  const codex = createCodexMcpServer({ policy, executable: 'codex.exe',
    probeCodex: async (_exe, _env, cwd) => { calls.push({ cwd }); return { account: { type: 'chatgpt' } }; },
    runCodexExec: async p => { calls.push(p); return { exitCode: 0, stdout: JSON.stringify({ type: 'thread.started', thread_id: id }), outputFileText: 'ok' }; },
  });
  return { agy, claude, codex, calls };
}

test('los tres proveedores comprueban la raíz y el permiso antes de cualquier efecto', async t => {
  const w = workspace(t), h = doubles(w.policy());
  const link = join(w.root, 'enlace');
  symlinkSync(w.sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [server, name, writeMode] of [[h.agy, 'antigravity_ask', { mode: 'accept-edits' }],
    [h.claude, 'claude_ask', { mode: 'edit' }], [h.codex, 'codex_ask', { sandbox: 'workspace-write' }]]) {
    for (const cwd of [w.sibling, 'relativa', link, w.root + '/../proyecto-extra']) denied(await call(server, name, { cwd, prompt: 'consulta' }));
    denied(await call(server, name, { cwd: w.child, prompt: 'consulta', ...writeMode }));
    denied(await call(server, name, { cwd: w.root, prompt: 'consulta', access: 'read-write' }));
  }
  for (const [server, name] of [[h.claude, 'claude_review'], [h.codex, 'codex_review'], [h.claude, 'claude_list_sessions']]) {
    denied(await call(server, name, { cwd: w.sibling }));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(existsSync(w.stateDir), false);
  assert.equal(existsSync(w.mailboxDir), false);
  for (const [server, name] of [[h.agy, 'antigravity_ask'], [h.claude, 'claude_ask'], [h.codex, 'codex_ask']]) {
    assert.equal((await call(server, name, { cwd: w.child, prompt: 'consulta' })).result.structuredContent.ok, true);
  }
  assert.ok(h.calls.every(p => p.cwd === w.child));
  assert.ok((await call(h.agy, 'antigravity_ask', { prompt: 'raíz implícita' })).result.structuredContent.ok);
  assert.equal(h.calls.at(-1).cwd, w.root);
  assert.throws(() => w.policy({ root: link }));
});

test('Windows rechaza directorios relativos a unidad, UNC, dispositivos y alias', { skip: process.platform !== 'win32' }, t => {
  const w = workspace(t), p = w.policy();
  const drive = w.root.slice(0, 2);
  for (const path of [drive + 'carpeta', '\\carpeta', '\\\\servidor\\recurso', '\\\\?\\' + w.root, w.child + '.', w.child + ':flujo']) assert.throws(() => p.authorize(path));
  assert.equal(p.authorize(w.child.toUpperCase()).toLowerCase(), w.child.toLowerCase());
});

test('la procedencia persiste por raíz y proveedor y nunca se deduce de un UUID conocido', async t => {
  const w = workspace(t), a = doubles(w.policy(), idA), b = doubles(w.policy({ root: w.sibling }), idB);
  for (const [server, name, field] of [[a.agy, 'antigravity_ask', 'conversationId'], [a.claude, 'claude_ask', 'sessionId'], [a.codex, 'codex_ask', 'sessionId']]) {
    denied(await call(server, name, { prompt: 'sesión heredada', [field]: idA }));
  }
  assert.equal(a.calls.length, 0);
  assert.equal(existsSync(w.stateDir), false);
  for (const [left, right, name, field] of [[a.agy, b.agy, 'antigravity_ask', 'conversationId'],
    [a.claude, b.claude, 'claude_ask', 'sessionId'], [a.codex, b.codex, 'codex_ask', 'sessionId']]) {
    assert.ok((await call(left, name, { prompt: 'nueva' })).result.structuredContent.ok);
    denied(await call(right, name, { prompt: 'ajena', [field]: idA }));
  }
  assert.equal(b.calls.length, 0);
  const again = doubles(w.policy());
  assert.ok((await call(again.agy, 'antigravity_ask', { prompt: 'continuar', conversationId: idA })).result.structuredContent.ok);
  const view = await call(again.agy, 'antigravity_list_conversations', {});
  assert.deepEqual(view.result.structuredContent.conversaciones.map(s => s.conversationId), [idA]);
  assert.deepEqual((await call(b.agy, 'antigravity_list_conversations', {})).result.structuredContent.conversaciones, []);
  denied(await call(again.agy, 'antigravity_ask', { cwd: w.sibling, conversationId: idA, prompt: 'fuera' }));
  const collision = doubles(w.policy({ root: w.sibling }), idA);
  denied(await call(collision.agy, 'antigravity_ask', { prompt: 'identificador duplicado devuelto por la CLI' }));
  assert.deepEqual((await call(collision.agy, 'antigravity_list_conversations', {})).result.structuredContent.conversaciones, []);
});

test('el buzón exige identidad, proyecto, acceso de escritura y propiedad de bandeja o archivo', async t => {
  const w = workspace(t);
  const instance = (actor, options = {}) => doubles(w.policy({ mailboxAs: actor, access: 'read-write', ...options })).agy;
  const sender = instance('codex'), recipient = instance('claude-code'), viewer = instance('claude-code', { access: 'read-only' });
  const message = { para: 'claude-code', tipo: 'aviso', asunto: 'prueba', cuerpo: 'mensaje de prueba' };
  denied(await call(sender, 'buzon_send', { ...message, de: 'antigravity' }));
  denied(await call(viewer, 'buzon_send', { ...message, para: 'codex' }));
  denied(await call(sender, 'buzon_list', { buzon: 'claude-code' }));
  denied(await call(instance(null), 'buzon_list', { buzon: 'codex' }));
  assert.equal(existsSync(w.mailboxDir), false);
  const sent = await call(sender, 'buzon_send', message), id = sent.result.structuredContent.id;
  const args = { buzon: 'claude-code', id };
  denied(await call(sender, 'buzon_read', args));
  denied(await call(sender, 'buzon_archive', args));
  denied(await call(viewer, 'buzon_archive', args));
  assert.match((await call(viewer, 'buzon_read', args)).result.structuredContent.texto, /de: codex/);
  denied(await call(instance('claude-code', { root: w.sibling }), 'buzon_read', args));
  assert.ok((await call(recipient, 'buzon_archive', args)).result.structuredContent.ok);
  assert.ok((await call(viewer, 'buzon_read', { buzon: 'archivo', id })).result.structuredContent.ok);
  denied(await call(sender, 'buzon_read', { buzon: 'archivo', id }));
});

function transport(t, server) {
  const input = new PassThrough(), output = new PassThrough();
  const replies = [], pending = [];
  let buffer = '';
  output.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (pending.length) pending.shift()(response); else replies.push(response);
    }
  });
  const done = server.start({ input, output, err: new PassThrough() });
  t.after(() => { input.end(); return done; });
  const take = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => pending.push(resolve));
  return { input, take, send: obj => input.write(JSON.stringify(obj) + '\n') };
}

test('exceso de bytes antes de LF se descarta por completo y recupera la trama siguiente', { timeout: 5000 }, async t => {
  let calls = 0;
  const server = createMcpStdioServer({ name: 'test', version: '1', tools: [{ name: 'test', handler: () => { calls++; return { text: 'ok' }; } }] });
  const io = transport(t, server);
  io.input.write(Buffer.alloc(MAX_MESSAGE_BYTES, 32));
  io.input.write(Buffer.from('ñ'));
  assert.equal((await io.take()).error.code, -32001);
  const valid = rpc(2, 'test');
  io.input.write(JSON.stringify(rpc(1, 'test')) + '\n' + JSON.stringify(valid) + '\n');
  assert.equal((await io.take()).id, 2);
  assert.equal(calls, 1);
  const line = Buffer.from(JSON.stringify(rpc(3, 'test')));
  io.input.write(Buffer.concat([Buffer.alloc(MAX_MESSAGE_BYTES - line.length, 32), line, Buffer.from('\n')]));
  assert.equal((await io.take()).id, 3);
});

test('la saturación no entra en el handler y libera puestos al terminar', { timeout: 5000 }, async t => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const server = createMcpStdioServer({ name: 'test', version: '1', tools: [{ name: 'test', handler: async () => {
    calls++; await gate; return { text: 'ok' };
  } }] });
  const io = transport(t, server);
  for (let i = 0; i <= MAX_IN_FLIGHT; i++) io.send(rpc(i, 'test'));
  const rejected = await io.take();
  assert.equal(rejected.id, MAX_IN_FLIGHT);
  assert.equal(rejected.error.code, -32002);
  assert.equal(calls, MAX_IN_FLIGHT);
  release();
  for (let i = 0; i < MAX_IN_FLIGHT; i++) assert.ok((await io.take()).result);
  io.send(rpc(100, 'test'));
  assert.equal((await io.take()).id, 100);
  assert.equal(calls, MAX_IN_FLIGHT + 1);
});

test('los ejemplos JSON del README arrancan y las configuraciones antiguas o ambiguas se rechazan', t => {
  const w = workspace(t);
  const doc = readFileSync(join(here, 'README.md'), 'utf8');
  const blocks = [...doc.matchAll(/\x60{3}json\n([\s\S]*?)\n\x60{3}/g)].map(m => JSON.parse(m[1]));
  assert.equal(blocks.length, 3);
  const run = (args, input) => spawnSync(process.execPath, args, { cwd: w.base, env: buildCliEnv(), windowsHide: true, encoding: 'utf8', input });
  for (const [i, block] of blocks.entries()) {
    for (const conf of Object.values(block.mcpServers)) {
      const args = conf.args.map(s => s.replace('<PUENTES>', here).replace('<PROYECTO>', w.root));
      const proc = run(args, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      assert.equal(proc.status, 0, proc.stderr);
      const names = JSON.parse(proc.stdout).result.tools.map(t => t.name);
      if (i === 0) assert.deepEqual(names, ['bridge_ping']);
      else assert.ok(names.some(n => n.endsWith('_ask')));
      if (i === 1) assert.ok(!args.includes('read-write'));
      if (i === 2) assert.ok(args.includes('read-write'));
    }
  }
  const script = join(here, 'antigravity-mcp-server.mjs');
  for (const flags of [['--allow-project-data'], ['--unknown'], ['--project-root', w.root], ['--allow-project-data', '--project-root', w.root, '--access', 'otro'],
    ['--allow-project-data', '--project-root', w.root, '--access', 'read-only', '--access', 'read-write']]) {
    const result = run([script, ...flags], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(w.root));
  }
});
