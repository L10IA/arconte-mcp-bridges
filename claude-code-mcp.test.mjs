import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeMcpServer, defaultRunProcess } from './claude-code-mcp-server.mjs';
import { appendBoundedOutput, resolveExecutable } from './mcp-stdio.mjs';

function call(server, name, args) {
  return server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

function makeWorkspace(t) {
  const root = resolve(tmpdir());
  const base = mkdtempSync(join(root, 'arconte-claude-mcp-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(base)), root);
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const cwd = join(base, 'repo');
  const claudeHome = join(base, 'claude-home');
  const outside = join(base, 'outside');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(join(claudeHome, 'projects'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { base, cwd, claudeHome, outside };
}

test('claude-code-local MCP: initialize, tools/list, status, ask, review, list_sessions y seguridad', async t => {
  const w = makeWorkspace(t);
  const calls = [];

  const server = createClaudeCodeMcpServer({
    executable: 'C:\\mock\\claude.exe',
    claudeHome: w.claudeHome,
    env: {
      PATH: 'C:\\Windows\\System32',
      ANTHROPIC_API_KEY: 'dummy-billed-anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'tok-should-be-stripped',
      KEEP_VAR: 'preserved',
    },
    runProcess: async ({ executable, args, cwd, env, stdinText, timeoutMs }) => {
      calls.push({ executable, args, cwd, env, stdinText, timeoutMs });
      if (args[0] === '--version') {
        return { stdout: '2.1.322 (Claude Code)\n', stderr: '', exitCode: 0, durationMs: 12 };
      }
      if (args.includes('auth') && args.includes('status')) {
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            subscriptionType: 'pro',
            planTier: 'pro',
            email: 'private@example.com',
            orgId: 'org-secret',
          }),
          stderr: '',
          exitCode: 0,
          durationMs: 18,
        };
      }
      return {
        stdout: JSON.stringify({
          type: 'result',
          is_error: false,
          session_id: args.includes('--resume') ? args[args.indexOf('--resume') + 1] : '11111111-1111-4111-8111-111111111111',
          num_turns: 2,
          duration_ms: 450,
          result: `OK:${stdinText?.slice(0, 30)}`,
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 450,
      };
    },
  });

  // 1. initialize
  const initRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(initRes.result.protocolVersion, '2025-03-26');
  assert.equal(initRes.result.serverInfo.name, 'claude-code-local');

  // 2. tools/list (4 exact tools)
  const listRes = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(
    listRes.result.tools.map(tool => tool.name),
    ['claude_status', 'claude_ask', 'claude_review', 'claude_list_sessions'],
  );

  // 3. claude_status (0 tokens, sin exponer email/orgId)
  const statusRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'claude_status', arguments: {} },
  });
  assert.equal(statusRes.result.isError, undefined);
  assert.equal(statusRes.result.structuredContent.ok, true);
  assert.deepEqual(Object.keys(statusRes.result.structuredContent).sort(), ['available', 'cliVersion', 'defaultModel', 'ok']);
  assert.doesNotMatch(statusRes.result.content[0].text, /mock|claude\.exe|\bpro\b/);
  assert.match(statusRes.result.content[0].text, /claude-fable-5-2/);
  assert.equal(JSON.stringify(statusRes).includes('private@example.com'), false);
  assert.equal(JSON.stringify(statusRes).includes('org-secret'), false);

  // 4. claude_ask read-only + stdin + sin ANTHROPIC_API_KEY
  const askRo = await server.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'claude_ask',
      arguments: { cwd: w.cwd, prompt: 'Analiza el módulo MCP', maxTurns: 3 },
    },
  });
  const roCall = calls.at(-1);
  assert.equal(roCall.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(roCall.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(roCall.env.KEEP_VAR, undefined);
  assert.equal(roCall.env.PATH, 'C:\\Windows\\System32');
  assert.equal(roCall.stdinText, 'Analiza el módulo MCP');
  assert.ok(roCall.args.includes('--permission-mode'));
  assert.equal(roCall.args[roCall.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(roCall.args.includes('--disallowedTools'));
  assert.ok(roCall.args.includes('--max-turns'));
  assert.equal(roCall.args[roCall.args.indexOf('--max-turns') + 1], '3');
  assert.equal(askRo.result.structuredContent.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(askRo.result.structuredContent.mode, 'read-only');
  assert.equal(askRo.result.structuredContent.model, 'claude-fable-5-2');

  // 5. claude_ask edit + --resume
  const askEdit = await server.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'claude_ask',
      arguments: {
        cwd: w.cwd,
        prompt: 'Aplica ajuste mínimo',
        mode: 'edit',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    },
  });
  const editCall = calls.at(-1);
  assert.equal(editCall.args[editCall.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(editCall.args[editCall.args.indexOf('--resume') + 1], '11111111-1111-4111-8111-111111111111');
  assert.equal(askEdit.result.structuredContent.mode, 'edit');
  assert.equal(askEdit.result.structuredContent.sessionId, '11111111-1111-4111-8111-111111111111');

  // 6. claude_review (solo lectura P0/P1/P2)
  const revRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'claude_review',
      arguments: { cwd: w.cwd, target: 'packages/mcp-bridges', focus: 'seguridad y symlinks' },
    },
  });
  const revCall = calls.at(-1);
  assert.equal(revCall.args[revCall.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(revCall.args.includes('--disallowedTools'));
  assert.match(revCall.stdinText, /P0.*P1.*P2/s);
  assert.match(revCall.stdinText, /packages\/mcp-bridges/);
  assert.equal(revRes.result.structuredContent.ok, true);

  // 7. claude_list_sessions: ordenado más reciente primero y sin seguir symlinks
  const slug = resolve(w.cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const slugDir = join(w.claudeHome, 'projects', slug);
  mkdirSync(slugDir, { recursive: true });
  const oldSess = join(slugDir, '11111111-1111-4111-8111-111111111111.jsonl');
  const newSess = join(slugDir, '22222222-2222-4222-8222-222222222222.jsonl');
  writeFileSync(oldSess, '{"a":1}\n', 'utf8');
  writeFileSync(newSess, '{"b":2}\n', 'utf8');
  const tOld = new Date('2026-11-20T10:00:00Z');
  const tNew = new Date('2026-11-23T10:00:00Z');
  utimesSync(oldSess, tOld, tOld);
  utimesSync(newSess, tNew, tNew);

  const outsideLog = join(w.outside, 'secret.jsonl');
  writeFileSync(outsideLog, '{"secret":true}\n', 'utf8');
  const linkedLog = join(slugDir, '33333333-3333-4333-8333-333333333333.jsonl');
  let fileSymCreated = true;
  try {
    symlinkSync(outsideLog, linkedLog, 'file');
  } catch {
    fileSymCreated = false;
  }

  const listSessRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'claude_list_sessions', arguments: { cwd: w.cwd } },
  });
  assert.equal(listSessRes.result.structuredContent.ok, true);
  assert.deepEqual(
    listSessRes.result.structuredContent.sessions.map(s => s.sessionId),
    [
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ],
  );
  assert.match(listSessRes.result.content[0].text, /- 22222222-2222-4222-8222-222222222222 · .* B/);
  assert.match(listSessRes.result.content[0].text, /- 11111111-1111-4111-8111-111111111111 · .* B/);
  if (fileSymCreated) {
    assert.equal(listSessRes.result.structuredContent.skippedSymlinks, 1);
  }

  // Symlink / junction como carpeta del slug debe rechazarse.
  const linkedCwd = join(w.base, 'linked-cwd');
  let dirSymCreated = true;
  try {
    symlinkSync(w.cwd, linkedCwd, 'junction');
  } catch {
    dirSymCreated = false;
  }
  if (dirSymCreated) {
    const badCwdCall = await server.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'claude_ask', arguments: { cwd: linkedCwd, prompt: 'hola' } },
    });
    assert.equal(badCwdCall.result.isError, true);

    const linkedSlug = resolve(w.outside).replace(/[^a-zA-Z0-9]/g, '-');
    const linkedSlugDir = join(w.claudeHome, 'projects', linkedSlug);
    try {
      symlinkSync(slugDir, linkedSlugDir, 'junction');
      const badSlugList = await server.handleMessage({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'claude_list_sessions', arguments: { cwd: w.outside } },
      });
      assert.equal(badSlugList.result.isError, true);
      rmSync(linkedSlugDir, { recursive: false, force: true });
    } catch {
      /* Ignore if junction creation is restricted. */
    }
    rmSync(linkedCwd, { recursive: false, force: true });
  }

  // 8. cwd inválido (relativo o inexistente) devuelve isError: true sin derribar el servidor.
  const relCwdRes = await server.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'claude_ask', arguments: { cwd: 'relative/path', prompt: 'hola' } },
  });
  assert.equal(relCwdRes.result.isError, true);
});

test('claude-code-local MCP responde por stdio JSON-RPC real como proceso hijo', async t => {
  const w = makeWorkspace(t);
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(repoRoot, 'claude-code-mcp-server.mjs');

  const child = spawn(process.execPath, [serverPath, '--allow-project-data'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      USERPROFILE: w.base,
      HOME: w.base,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  t.after(() => {
    try {
      child.kill();
    } catch {
      /* Already exited. */
    }
  });

  const responses = [];
  let buffer = '';
  const waiters = [];
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      responses.push(msg);
      while (waiters.length > 0) waiters.shift()();
    }
  });

  const waitForCount = async count => {
    const deadline = Date.now() + 8000;
    while (responses.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timeout esperando ${count} respuestas stdio (recibidas ${responses.length}).`);
      }
      await new Promise(resolveWait => {
        const timer = setTimeout(resolveWait, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  };

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'stdio-test', version: '1.0' } },
    }) + '\n',
  );
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) + '\n');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'claude_list_sessions', arguments: { cwd: w.cwd } },
    }) + '\n',
  );
  child.stdin.end();

  await waitForCount(4);
  const exitCode = await new Promise(resolveExit => child.once('close', resolveExit));
  assert.equal(exitCode, 0);
  assert.deepEqual(
    responses.map(r => r.id),
    [1, 2, 3, 4],
  );
  assert.equal(responses[0].result.serverInfo.name, 'claude-code-local');
  assert.deepEqual(responses[1].result, {});
  assert.equal(responses[2].result.tools.length, 4);
  assert.equal(responses[3].result.structuredContent.ok, true);
  assert.deepEqual(responses[3].result.structuredContent.sessions, []);
});

test('Claude limita herramientas y aísla ajustes del proyecto y MCP en lectura y plan', async t => {
  const w = makeWorkspace(t);
  const runs = [];
  const server = createClaudeCodeMcpServer({
    executable: 'claude.exe',
    runProcess: async params => {
      runs.push(params);
      if (params.args.includes('auth')) return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' };
      return { exitCode: 0, stdout: '{"result":"listo"}', stderr: '', durationMs: 1 };
    },
  });
  for (const mode of ['read-only', 'plan']) {
    const response = await call(server, 'claude_ask', { cwd: w.cwd, prompt: 'Revisa', mode });
    assert.equal(response.result.structuredContent.ok, true);
    const execution = runs.at(-1).args;
    assert.equal(execution[execution.indexOf('--setting-sources') + 1], 'user');
    assert.ok(execution.includes('--strict-mcp-config'));
    assert.ok(!execution.includes('--bare'));
    if (mode === 'read-only') {
      assert.equal(execution[execution.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
      assert.equal(execution[execution.indexOf('--tools') + 1], 'Read,Grep,Glob');
      assert.ok(!execution.some(arg => arg.includes('Bash')));
    }
    const auth = runs.at(-2);
    assert.equal(auth.cwd, w.cwd);
    assert.ok(auth.args.includes('--strict-mcp-config'));
  }
});

test('Claude comprueba la suscripción y sanea proveedor, cuenta y destino antes de cada ejecución', async t => {
  const w = makeWorkspace(t);
  let auth = { loggedIn: true, authMethod: 'api' };
  let executions = 0;
  const env = {
    ANTHROPIC_API_KEY: 'dummy', ANTHROPIC_BASE_URL: 'https://example.invalid',
    ANTHROPIC_FOUNDRY_API_KEY: 'dummy', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_MANTLE: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'dummy', CLAUDE_CONFIG_DIR: 'otro', AWS_BEARER_TOKEN_BEDROCK: 'dummy',
    CLOUD_ML_REGION: 'region', VERTEX_REGION_CLAUDE_TEST: 'region', KEEP: 'sí',
  };
  const server = createClaudeCodeMcpServer({
    executable: 'claude.exe', env,
    runProcess: async params => {
      assert.deepEqual(params.env, {});
      if (params.args.includes('auth')) return { exitCode: 0, stdout: JSON.stringify(auth) };
      if (params.args.includes('--version')) return { exitCode: 0, stdout: '2.1.322' };
      executions++;
      return { exitCode: 0, stdout: '{"result":"listo"}', stderr: '', durationMs: 1 };
    },
  });
  for (const account of [auth, { loggedIn: false, authMethod: 'claude.ai' }, {}, { loggedIn: true, authMethod: null }]) {
    auth = account;
    for (const name of ['claude_ask', 'claude_review']) {
      const result = await call(server, name, { cwd: w.cwd, prompt: 'Consulta', model: 'sonnet' });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /suscripción claude\.ai/);
    }
  }
  assert.equal(executions, 0);
  auth = { loggedIn: true, authMethod: 'claude.ai' };
  assert.equal((await call(server, 'claude_ask', { cwd: w.cwd, prompt: 'Consulta' })).result.structuredContent.ok, true);
  assert.equal(executions, 1);
  const statusWithKey = (await call(server, 'claude_status', {})).result;
  const noKeyServer = createClaudeCodeMcpServer({ executable: 'claude.exe', env: {}, runProcess: async p =>
    p.args.includes('auth') ? { exitCode: 0, stdout: JSON.stringify(auth) } : { exitCode: 0, stdout: '2.1.322' } });
  assert.deepEqual(statusWithKey, (await call(noKeyServer, 'claude_status', {})).result);
});

test('Claude rechaza opciones que parecen flags, UUID inválidos, tipos y ejecutables de shell', async t => {
  const w = makeWorkspace(t);
  let invoked = 0;
  const server = createClaudeCodeMcpServer({ executable: 'claude.exe', runProcess: async () => { invoked++; } });
  for (const extra of [
    { model: '-p' }, { model: 'un-modelo-arbitrario' }, { sessionId: '--help' },
    { sessionId: 'sesion-invalida' }, { timeoutSec: '5' }, { timeoutSec: 5.5 }, { maxTurns: '2' },
  ]) {
    assert.equal((await call(server, 'claude_ask', { cwd: w.cwd, prompt: 'Hola', ...extra })).result.isError, true);
  }
  const script = join(w.base, 'claude.CMD');
  writeFileSync(script, 'rem stub');
  assert.equal(resolveExecutable('', [script], []), null);
  const scriptServer = createClaudeCodeMcpServer({ executable: script, runProcess: async () => { invoked++; } });
  assert.equal((await call(scriptServer, 'claude_ask', { cwd: w.cwd, prompt: 'Hola' })).result.isError, true);
  assert.equal(invoked, 0);
});

test('Claude conserva el cerrojo de edit y rechaza otro escritor con los PID aún vivos', async t => {
  const { cwd, base } = makeWorkspace(t);
  const lockDir = join(base, 'locks');
  let writes = 0;
  const server = createClaudeCodeMcpServer({
    executable: 'claude.exe', lockDir,
    runProcess: async ({ args, onSpawn }) => {
      if (args.includes('auth')) return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' };
      writes++;
      onSpawn(process.pid);
      return { exitCode: 124, timedOut: true, treeTerminated: false, stdout: '', stderr: '' };
    },
  });
  const write = () => call(server, 'claude_ask', { cwd, prompt: 'Editar', mode: 'edit' });
  const timeout = await write();
  assert.equal(timeout.result.isError, true);
  assert.match(timeout.result.content[0].text, /terminación del árbol/);
  const [name] = readdirSync(lockDir);
  assert.match(name, /\.lock$/);
  const path = join(lockDir, name);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.unterminatedTree, true);
  assert.equal(record.pid, process.pid);
  assert.equal(record.childPid, process.pid);
  const retry = await write();
  assert.equal(retry.result.isError, true);
  assert.match(retry.result.content[0].text, /escritor previo.*terminación del árbol.*limpieza manual/i);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record);
});

test('Claude corta la salida y resuelve el tiempo de espera aunque el hijo no cierre', async t => {
  const w = makeWorkspace(t);
  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123; child.kill = () => true;
    return child;
  };
  let terminated = 0;
  let registeredPid;
  const timedOut = await defaultRunProcess({
    executable: 'claude.exe', args: [], cwd: w.cwd, env: {}, timeoutMs: 20,
    spawnProcess: () => fakeChild(), terminate: async () => { terminated++; }, onSpawn: pid => { registeredPid = pid; },
  });
  assert.equal(timedOut.exitCode, 124);
  assert.equal(timedOut.timedOut, true);
  assert.equal(terminated, 1);
  assert.equal(registeredPid, 123);
  const oversized = await defaultRunProcess({
    executable: 'claude.exe', args: [], cwd: w.cwd, env: {}, timeoutMs: 1000,
    spawnProcess: () => {
      const child = fakeChild();
      process.nextTick(() => { child.stdout.write('x'.repeat(4 * 1024 * 1024 + 100)); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(oversized.truncated, true);
  assert.equal(Buffer.byteLength(oversized.stdout), 4 * 1024 * 1024);
  const multibyte = { text: '', bytes: 0, truncated: false };
  appendBoundedOutput(multibyte, 'abc😀', 5);
  assert.equal(multibyte.text, 'abc');
  assert.equal(multibyte.truncated, true);
  const server = createClaudeCodeMcpServer({ executable: 'claude.exe', runProcess: async params =>
    params.args.includes('auth') ? { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' } :
      { exitCode: 0, stdout: '{"result":"aparentemente correcto"}', truncated: true, durationMs: 1 } });
  const result = await call(server, 'claude_ask', { cwd: w.cwd, prompt: 'Consulta' });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.ok, false);
  assert.match(result.result.content[0].text, /truncada/);
  const timedOutServer = createClaudeCodeMcpServer({ executable: 'claude.exe', runProcess: async params =>
    params.args.includes('auth') ? { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' } :
      { exitCode: 124, stdout: '{"result":"parcial"}', timedOut: true, treeTerminated: false, durationMs: 1 } });
  const timeoutResult = await call(timedOutServer, 'claude_ask', { cwd: w.cwd, prompt: 'Consulta' });
  assert.equal(timeoutResult.result.isError, true);
  assert.match(timeoutResult.result.content[0].text, /Tiempo de espera.*no se pudo confirmar/i);
});
