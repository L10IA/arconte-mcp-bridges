import { testPolicy, testEnv } from './test-policy.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAntigravityMcpServer } from './antigravity-mcp-server.mjs';
import { createClaudeCodeMcpServer, parseClaudeJsonResult } from './claude-code-mcp-server.mjs';
import { createCodexMcpServer } from './codex-mcp-server.mjs';
import { BridgeError, buildCliEnv, createMcpStdioServer, terminateProcessTree } from './mcp-stdio.mjs';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const call = (server, name, args) => server.handleMessage(request(1, 'tools/call', { name, arguments: args }));

test('un error con ruta privada y un diagnóstico JSON de la CLI quedan fuera de la respuesta', async () => {
  const server = createMcpStdioServer({ name: 'prueba', version: '1', tools: [
    { name: 'prueba', handler() { throw new BridgeError('detalle /home/usuario-ficticio/privado'); } },
  ] });
  const reply = await call(server, 'prueba', {});
  assert.ok(reply.result.isError);
  assert.ok(!JSON.stringify(reply).includes('usuario-ficticio'));
  const diagnostic = JSON.stringify({ type: 'system', message: 'diagnóstico reservado de prueba' });
  const result = parseClaudeJsonResult(diagnostic, '', 0, { mode: 'read-only' });
  assert.ok(result.isError);
  assert.ok(!JSON.stringify(result).includes('reservado'));
});

test('una señal al hijo en POSIX no confirma la terminación de todos los descendientes', async () => {
  let signalled = false;
  const child = { pid: 42, kill() { signalled = true; } };
  assert.equal(await terminateProcessTree(child, { platform: 'linux' }), false);
  assert.ok(signalled);
});

test('cada punto de entrada ofrece solo una comprobación local por defecto', t => {
  const base = mkdtempSync(join(tmpdir(), 'arconte-ping-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const provider of ['codex', 'claude-code', 'antigravity']) {
    const script = fileURLToPath(new URL(`./${provider}-mcp-server.mjs`, import.meta.url));
    const inputs = [
      request(1, 'initialize'), request(2, 'tools/list'),
      request(3, 'tools/call', { name: 'bridge_ping', arguments: {} }),
      request(4, 'tools/call', { name: 'bridge_ping', arguments: { note: 'texto de prueba reservado' } }),
      request(5, 'tools/call', { name: 'buzon_list', arguments: {} }),
      request(6, 'tools/call', { name: 'antigravity_ask', arguments: { prompt: 'texto de prueba reservado' } }),
    ];
    const proc = spawnSync(process.execPath, [script], {
      input: inputs.map(row => JSON.stringify(row)).join('\n') + '\n', encoding: 'utf8',
      env: testEnv(base), cwd: base, windowsHide: true, timeout: 8000,
    });
    assert.equal(proc.status, 0);
    assert.equal(proc.stderr, '');
    assert.ok(!proc.stdout.includes('texto de prueba reservado'));
    const [, list, ping, extra, mailbox, ask] = proc.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(list.result.tools.map(t => t.name), ['bridge_ping']);
    assert.deepEqual(ping.result.structuredContent, { ok: true, mode: 'connection-only' });
    assert.equal(extra.result.isError, true);
    assert.ok(mailbox.error && ask.error);
  }
});

test('el entorno de la CLI excluye valores desconocidos, credenciales y opciones de inyección', () => {
  assert.deepEqual(buildCliEnv({ Path: 'bin', SystemRoot: 'raíz', HOME: '/perfil',
    NOMINA: 'privado', NODE_OPTIONS: '--inspect', GITHUB_TOKEN: 'inventado', HTTPS_PROXY: 'inventado' }),
    { Path: 'bin', SystemRoot: 'raíz', HOME: '/perfil' });
});

test('los tres puentes bloquean contenido privado antes de iniciar procesos o escribir al buzón', async t => {
  const base = mkdtempSync(join(tmpdir(), 'mcp-privacy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'proyecto');
  mkdirSync(cwd);
  let calls = 0;
  const processStub = () => { calls++; throw new Error('diagnóstico ficticio privado'); };
  const agy = createAntigravityMcpServer({ policy: testPolicy(cwd, { mailboxAs: 'codex' }), executable: 'agy.exe', runProcess: processStub });
  const claude = createClaudeCodeMcpServer({ policy: testPolicy(cwd), executable: 'claude.exe', runProcess: processStub });
  const codex = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', probeCodex: processStub });
  const fictional = ['persona@example.invalid', 'Bearer tokenFicticio123', 'password=valor-inventado',
    '/home/usuario-ficticio/privado', '-----BEGIN PRIVATE KEY-----'];
  for (const input of fictional) {
    for (const [server, name] of [[agy, 'antigravity_ask'], [claude, 'claude_ask'], [codex, 'codex_ask']]) {
      const answer = await call(server, name, { cwd, prompt: input });
      assert.equal(answer.result.isError, true);
      assert.ok(!JSON.stringify(answer).includes(input));
    }
    const reply = await call(agy, 'buzon_send', { de: 'codex', para: 'antigravity', tipo: 'aviso', asunto: 'prueba', cuerpo: input });
    assert.equal(reply.result.isError, true);
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(cwd), []);
  assert.equal(existsSync(join(cwd, 'para-antigravity')), false);
});

test('los diagnósticos y las respuestas sensibles no llegan al cliente', async t => {
  const base = mkdtempSync(join(tmpdir(), 'mcp-privacy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'proyecto');
  mkdirSync(cwd);
  const diagnostic = 'nota interna inventada del proveedor';
  const agy = createAntigravityMcpServer({ policy: testPolicy(cwd), executable: 'agy.exe', runProcess: async () =>
    ({ stdout: JSON.stringify({ response: 'privado@example.invalid' }), stderr: diagnostic, exitCode: 0 }) });
  const claude = createClaudeCodeMcpServer({ policy: testPolicy(cwd), executable: 'claude.exe', runProcess: async p => p.args.includes('auth')
    ? { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', exitCode: 0 }
    : { stdout: diagnostic, stderr: diagnostic, exitCode: 1 } });
  const codex = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', probeCodex: async () => ({ account: { type: 'chatgpt' } }),
    runCodexExec: async () => ({ stdout: '', stderr: diagnostic, outputFileText: diagnostic, exitCode: 1 }) });
  for (const [server, name] of [[agy, 'antigravity_ask'], [claude, 'claude_ask'], [codex, 'codex_ask']]) {
    const answer = await call(server, name, { cwd, prompt: 'prueba' });
    assert.ok(answer.result.isError);
    assert.ok(!JSON.stringify(answer).includes(diagnostic));
    assert.ok(!JSON.stringify(answer).includes('privado@example.invalid'));
  }
});
