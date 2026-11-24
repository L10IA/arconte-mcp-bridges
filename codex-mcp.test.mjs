import { testPolicy } from './test-policy.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createCodexMcpServer,
  defaultProbeAppServer,
  defaultRunCodexExec,
  discoverCodexDesktopExecutable,
  resolveCompatibleCodexModel,
} from './codex-mcp-server.mjs';
import { createClaudeCodeMcpServer } from './claude-code-mcp-server.mjs';
import { resolveExecutable, terminateProcessTree, withCwdWriteLock } from './mcp-stdio.mjs';

function call(server, name, args) {
  return server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

test('codex-local MCP: initialize, ping, tools/list, codex_status y codex_models con fallback gpt-6.2-sol -> gpt-6.1-terra', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-mcp-meta-'));
  try {
    const workDir = join(root, 'repo');
    mkdirSync(workDir, { recursive: true });
    let execCalled = 0;

    const server = createCodexMcpServer({
      policy: testPolicy(workDir),
      executable: process.execPath,
      defaultCwd: workDir,
      baseEnv: {
        PATH: process.env.PATH ?? '',
        OPENAI_API_KEY: 'sk-should-be-stripped',
        CODEX_API_KEY: 'sk-should-be-stripped',
      },
      probeCodex: async (_exe, env) => {
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.equal(env.CODEX_API_KEY, undefined);
        return {
          cliVersion: 'codex-cli 0.163.0',
          account: { type: 'chatgpt', planType: 'pro' },
          configuredModel: 'gpt-6.2-sol',
          modelList: {
            data: [
              { id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', isDefault: true, hidden: false },
              { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: false, hidden: false },
              { id: 'gpt-internal-hidden', model: 'gpt-internal-hidden', isDefault: false, hidden: true },
            ],
          },
        };
      },
      runCodexExec: async () => {
        execCalled += 1;
        throw new Error('No debe ejecutarse codex exec en status/models');
      },
    });

    const initRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } },
    });
    assert.equal(initRes.result.protocolVersion, '2025-03-26');
    assert.equal(initRes.result.serverInfo.name, 'codex-local');

    const notifRes = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notifRes, null);

    const pingRes = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(pingRes.result, {});

    const listRes = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.deepEqual(
      listRes.result.tools.map(t => t.name),
      ['codex_status', 'codex_models', 'codex_ask', 'codex_review'],
    );

    const statusRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'codex_status', arguments: {} },
    });
    assert.equal(statusRes.result.isError, undefined);
    assert.equal(statusRes.result.structuredContent.ok, true);
    assert.equal(statusRes.result.structuredContent.cliVersion, 'codex-cli 0.163.0');
    assert.equal(statusRes.result.structuredContent.available, true);
    assert.equal(Object.hasOwn(statusRes.result.structuredContent, 'account'), false);
    assert.equal(Object.hasOwn(statusRes.result.structuredContent, 'executablePath'), false);
    assert.ok(!statusRes.result.content[0].text.includes(process.execPath));
    assert.equal(statusRes.result.structuredContent.configuredModel, 'gpt-6.2-sol');
    assert.equal(statusRes.result.structuredContent.effectiveDefaultModel, 'gpt-6.1-terra');
    assert.equal(statusRes.result.structuredContent.supportedModelCount, 2);
    assert.match(statusRes.result.content[0].text, /codex-cli 0\.163\.0/);
    assert.match(statusRes.result.content[0].text, /gpt-6\.1-terra/);

    const modelsRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'codex_models', arguments: {} },
    });
    assert.equal(modelsRes.result.structuredContent.ok, true);
    assert.equal(modelsRes.result.structuredContent.configuredModel, 'gpt-6.2-sol');
    assert.equal(modelsRes.result.structuredContent.effectiveDefaultModel, 'gpt-6.1-terra');
    assert.deepEqual(
      modelsRes.result.structuredContent.models.map(m => m.id),
      ['gpt-6.1-terra', 'gpt-6.1-sol'],
    );
    assert.match(modelsRes.result.content[0].text, /- gpt-6\.1-terra \(GPT-6\.1 Terra\) · default/);
    assert.match(modelsRes.result.content[0].text, /- gpt-6\.1-sol \(GPT-6\.1-Sol\)/);
    assert.equal(execCalled, 0);

    // Verifica helper directo cuando configuredModel si es compatible
    const direct = resolveCompatibleCodexModel('gpt-6.1-sol', {
      data: [
        { id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', isDefault: true },
        { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', isDefault: false },
      ],
    });
    assert.equal(direct.effectiveDefaultModel, 'gpt-6.1-sol');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex-local MCP: codex_ask (read-only, resume, stdin, sin OPENAI_API_KEY) y codex_review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-mcp-exec-'));
  try {
    const workDir = join(root, 'workspace');
    mkdirSync(join(workDir, '.git'), { recursive: true });
    const calls = [];
    let observedTmpOutPath = null;

    const server = createCodexMcpServer({
      policy: testPolicy(workDir),
      executable: 'C:\\Stub\\codex.exe',
      defaultCwd: workDir,
      baseEnv: {
        PATH: process.env.PATH ?? '',
        OPENAI_API_KEY: 'sk-test-must-strip',
        OPENAI_BASE_URL: 'https://billed.invalid',
        OPENAI_API_BASE: 'https://billed.invalid',
        CODEX_API_KEY: 'sk-codex-must-strip',
        SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
      },
      probeCodex: async () => ({
        cliVersion: 'codex-cli 0.163.0',
        account: { type: 'chatgpt', planType: 'pro' },
        configuredModel: 'gpt-6.2-sol',
        modelList: {
          data: [{ id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', isDefault: true, hidden: false }],
        },
      }),
      runCodexExec: async call => {
        calls.push(call);
        observedTmpOutPath = call.tmpOutFile;
        assert.equal(call.env.OPENAI_API_KEY, undefined);
        assert.equal(call.env.OPENAI_BASE_URL, undefined);
        assert.equal(call.env.OPENAI_API_BASE, undefined);
        assert.equal(call.env.CODEX_API_KEY, undefined);

        if (call.args.includes('review')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: 'item.completed',
              item: { id: 'r1', type: 'agent_message', text: 'REVISION_OK: sin hallazgos P0' },
            }) + '\n',
            stderr: '',
            durationMs: 42,
            timedOut: false,
            outputFileText: 'REVISION_OK: sin hallazgos P0',
          };
        }

        const isResume = call.args.includes('resume');
        const threadId = isResume ? '12345678-1111-4111-8111-123456789abc' : '12345678-1111-4111-8111-123456789abc';
        const answer = isResume ? 'RESUMED_OK' : 'READONLY_OK';
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: 'thread.started', thread_id: threadId }),
            JSON.stringify({ type: 'turn.started' }),
            JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: answer } }),
          ].join('\n'),
          stderr: 'info log',
          durationMs: 55,
          timedOut: false,
          outputFileText: answer,
        };
      },
    });

    // 1) codex_ask read-only inicial
    const ask1 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'codex_ask',
        arguments: {
          cwd: workDir,
          prompt: 'Analiza este proyecto en solo lectura.',
        },
      },
    });
    assert.equal(ask1.result.structuredContent.ok, true);
    assert.equal(ask1.result.structuredContent.sessionId, '12345678-1111-4111-8111-123456789abc');
    assert.equal(ask1.result.structuredContent.model, 'gpt-6.1-terra');
    assert.equal(ask1.result.structuredContent.sandbox, 'read-only');
    assert.equal(ask1.result.structuredContent.answer, 'READONLY_OK');
    assert.match(ask1.result.content[0].text, /^READONLY_OK\n\n\[codex-local · model=gpt-6\.1-terra · sessionId=12345678-1111-4111-8111-123456789abc\]$/);
    assert.equal(ask1.result.structuredContent.exitCode, 0);
    assert.equal(existsSync(observedTmpOutPath), false, 'Debe limpiar archivo temporal -o en finally');
    assert.deepEqual(calls[0].args.slice(0, 7), ['exec', '-C', workDir, '-s', 'read-only', '-m', 'gpt-6.1-terra']);
    assert.ok(calls[0].args.includes('--ignore-user-config'));
    assert.equal(calls[0].args.at(-1), '-');
    assert.equal(calls[0].prompt, 'Analiza este proyecto en solo lectura.');

    // 2) codex_ask resume con sessionId y workspace-write
    const ask2 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'codex_ask',
        arguments: {
          cwd: workDir,
          prompt: 'Continua el analisis previo.',
          sandbox: 'workspace-write',
          sessionId: '12345678-1111-4111-8111-123456789abc',
          model: 'gpt-6.1-sol',
        },
      },
    });
    assert.equal(ask2.result.structuredContent.ok, true);
    assert.equal(ask2.result.structuredContent.sessionId, '12345678-1111-4111-8111-123456789abc');
    assert.equal(ask2.result.structuredContent.model, 'gpt-6.1-sol');
    assert.equal(ask2.result.structuredContent.sandbox, 'workspace-write');
    assert.equal(ask2.result.structuredContent.answer, 'RESUMED_OK');
    assert.deepEqual(calls[1].args.slice(0, 8), [
      'exec',
      '-C',
      workDir,
      '-s',
      'workspace-write',
      'resume',
      '-m',
      'gpt-6.1-sol',
    ]);
    assert.equal(calls[1].args.at(-2), '12345678-1111-4111-8111-123456789abc');
    assert.equal(calls[1].args.at(-1), '-');
    assert.ok(!calls[1].args.includes('--ignore-user-config'));

    // 3) codex_review uncommitted (read-only estricto)
    const rev1 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'codex_review',
        arguments: { cwd: workDir, uncommitted: true },
      },
    });
    assert.equal(rev1.result.structuredContent.ok, true);
    assert.equal(rev1.result.structuredContent.model, 'gpt-6.1-terra');
    assert.equal(rev1.result.structuredContent.review, 'REVISION_OK: sin hallazgos P0');
    assert.ok(calls[2].args.includes('review'));
    assert.ok(calls[2].args.includes('--uncommitted'));
    assert.ok(calls[2].args.includes('--ignore-user-config'));
    assert.equal(calls[2].args[4], 'read-only');

    // 4) codex_review con base + prompt personalizado (evita conflicto Clap usando codex exec read-only)
    const rev2 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'codex_review',
        arguments: { cwd: workDir, base: 'main', prompt: 'Busca regresiones P0/P1.' },
      },
    });
    assert.equal(rev2.result.structuredContent.ok, true);
    assert.equal(calls[3].args[4], 'read-only');
    assert.ok(calls[3].args.includes('--ignore-user-config'));
    assert.match(calls[3].prompt, /main/);
    assert.match(calls[3].prompt, /Busca regresiones P0\/P1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex-local MCP: rechaza cwd invalido, UNC, symlink/junction, sandbox no permitido y trabaja sobre flujo stdio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-mcp-sec-'));
  const junctions = [];
  try {
    const realDir = join(root, 'real');
    const outsideDir = join(root, 'outside');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const linkedDir = join(root, 'linked-cwd');
    symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    junctions.push(linkedDir);

    const server = createCodexMcpServer({
      policy: testPolicy(realDir),
      executable: 'C:\\Stub\\codex.exe',
      defaultCwd: realDir,
      probeCodex: async () => ({
        cliVersion: 'codex-cli 0.163.0',
        account: { type: 'chatgpt', planType: 'pro' },
        configuredModel: 'gpt-6.1-terra',
        modelList: { data: [{ id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', isDefault: true }] },
      }),
      runCodexExec: async () => {
        throw new Error('No debe invocarse codex exec ante cwd/sandbox invalidos');
      },
    });

    for (const badCwd of [
      'ruta/relativa',
      '\\\\servidor\\compartido',
      join(root, 'no-existe'),
      linkedDir,
    ]) {
      const res = await server.handleMessage({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'codex_ask',
          arguments: { cwd: badCwd, prompt: 'Hola' },
        },
      });
      assert.equal(res.result.isError, true, `Debe rechazar cwd inválido: ${badCwd}`);
    }

    const badSandbox = await server.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'codex_ask',
        arguments: { cwd: realDir, prompt: 'Hola', sandbox: 'danger-full-access' },
      },
    });
    assert.equal(badSandbox.result.isError, true);

    // Prueba de transporte stdio JSON-RPC real (PassThrough stdin/stdout)
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let outBuf = '';
    stdout.setEncoding('utf8').on('data', chunk => {
      outBuf += chunk;
    });

    const loopPromise = server.start({ input: stdin, output: stdout, err: stderr });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    stdin.end();
    await loopPromise;

    const lines = outBuf.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].result.protocolVersion, '2024-11-05');
    assert.equal(lines[1].result.tools.length, 4);
  } finally {
    for (const j of junctions) {
      try {
        rmdirSync(j);
      } catch {
        /* ignore cleanup errors */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCodexDesktopExecutable descubre CODEX_CLI_PATH y notify, rechazando UNC, no-codex.exe y symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-discover-'));
  const junctions = [];
  try {
    const fakeHome = join(root, 'home');
    const codexDir = join(fakeHome, '.codex');
    const resourcesDir = join(root, 'OpenAI.Codex', 'app', 'resources');
    const cuaDir = join(resourcesDir, 'cua_node', 'bin');
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(cuaDir, { recursive: true });

    const validCodexExe = join(resourcesDir, 'codex.exe');
    const otherExe = join(resourcesDir, 'other.exe');
    const notifyExe = join(cuaDir, 'codex-computer-use.exe');
    writeFileSync(validCodexExe, 'stub', 'utf8');
    writeFileSync(otherExe, 'stub', 'utf8');
    writeFileSync(notifyExe, 'stub', 'utf8');

    // 1. Descubre CODEX_CLI_PATH válido
    const configFile = join(codexDir, 'config.toml');
    writeFileSync(
      configFile,
      `model = "gpt-6.2-sol"\n[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = '${validCodexExe}'\n`,
      'utf8',
    );
    assert.equal(discoverCodexDesktopExecutable(fakeHome), validCodexExe);

    // 2. Descubre fallback desde notify si no existe CODEX_CLI_PATH
    const escapedNotify = notifyExe.replace(/\\/g, '\\\\');
    writeFileSync(configFile, `notify = [ "${escapedNotify}", "turn-ended" ]\n`, 'utf8');
    assert.equal(discoverCodexDesktopExecutable(fakeHome), validCodexExe);
    writeFileSync(configFile, `notify = [\n  "${escapedNotify}", "turn-ended" ]\n`, 'utf8');
    assert.equal(discoverCodexDesktopExecutable(fakeHome), validCodexExe);

    writeFileSync(configFile, `  # CODEX_CLI_PATH = '${validCodexExe}'\n# notify = [ "${escapedNotify}" ]\nother = 'ignorado' # CODEX_CLI_PATH = '${validCodexExe}'\n`, 'utf8');
    assert.equal(discoverCodexDesktopExecutable(fakeHome), null);

    // 3. Rechaza UNC, rutas relativas y archivos distintos de codex.exe
    writeFileSync(
      configFile,
      `CODEX_CLI_PATH = "\\\\\\\\evil\\\\share\\\\codex.exe"\n[mcp_servers.a.env]\nCODEX_CLI_PATH = '${otherExe}'\n`,
      'utf8',
    );
    assert.equal(discoverCodexDesktopExecutable(fakeHome), null);

    // 4. Rechaza rutas que pasan por un symlink/junction
    const linkedResources = join(root, 'linked-resources');
    symlinkSync(resourcesDir, linkedResources, process.platform === 'win32' ? 'junction' : 'dir');
    junctions.push(linkedResources);
    writeFileSync(configFile, `CODEX_CLI_PATH = '${join(linkedResources, 'codex.exe')}'\n`, 'utf8');
    assert.equal(discoverCodexDesktopExecutable(fakeHome), null);
  } finally {
    for (const j of junctions) {
      try {
        rmdirSync(j);
      } catch {
        /* ignore */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex verifica ChatGPT con modelo explícito y limpia variables de cuenta y destino', async t => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); mkdirSync(cwd);
  const env = { OPENAI_API_KEY: 'dummy', OPENAI_BASE_URL: 'https://example.invalid', OPENAI_API_BASE: 'https://example.invalid',
    OPENAI_ORGANIZATION: 'dummy', OPENAI_PROJECT_ID: 'dummy', CODEX_API_KEY: 'dummy',
    CODEX_ACCESS_TOKEN: 'dummy', CODEX_HOME: 'otro', KEEP: 'privado', Path: 'ruta-de-prueba' };
  let account = { type: 'apiKey' };
  let executions = 0;
  let resolutions = 0;
  const server = createCodexMcpServer({ policy: testPolicy(cwd), resolveCodex: () => { resolutions++; return 'codex.exe'; }, baseEnv: env,
    probeCodex: async (_exe, clean) => {
      assert.deepEqual(clean, { Path: 'ruta-de-prueba' });
      if (account?.type === 'chatgpt') env.Path = 'modificado después de la sonda';
      return { account, modelList: {} };
    },
    runCodexExec: async params => {
      executions++;
      assert.equal(params.executable, 'codex.exe');
      assert.deepEqual(params.env, { Path: 'ruta-de-prueba' });
      return { exitCode: 0, stdout: '', stderr: '', outputFileText: 'listo' };
    },
  });
  for (const value of [{ type: 'apiKey' }, {}, null]) {
    account = value;
    for (const name of ['codex_ask', 'codex_review']) {
      const response = await call(server, name, { cwd, prompt: 'Consulta', model: 'gpt-6.1-sol' });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /cuenta ChatGPT verificada/);
    }
  }
  assert.equal(executions, 0);
  account = { type: 'chatgpt' };
  const previousResolutions = resolutions;
  assert.equal((await call(server, 'codex_ask', { cwd, prompt: 'Consulta', model: 'gpt-6.1-sol' })).result.structuredContent.ok, true);
  assert.equal(executions, 1);
  assert.equal(resolutions, previousResolutions + 1);
  const descriptions = (await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  for (const name of ['codex_ask', 'codex_review']) {
    assert.match(descriptions.find(tool => tool.name === name).description, /MCP.*proyecto.*sandbox/);
  }
});

test('Codex rechaza tipos inválidos y .cmd/.bat antes de llamar al ejecutable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-args-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); mkdirSync(cwd);
  let probes = 0;
  const server = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', probeCodex: async () => { probes++; } });
  for (const [name, extra] of [
    ['codex_ask', { ephemeral: 'false' }], ['codex_ask', { ephemeral: 1 }],
    ['codex_ask', { timeoutSec: '5' }], ['codex_review', { uncommitted: 'false' }],
    ['codex_review', { timeoutSec: NaN }],
  ]) {
    assert.equal((await call(server, name, { cwd, prompt: 'Consulta', ...extra })).result.isError, true);
  }
  const script = join(root, 'codex.BAT'); writeFileSync(script, 'rem stub');
  assert.equal(resolveExecutable('', [script], []), null);
  const bad = createCodexMcpServer({ policy: testPolicy(cwd), executable: script, probeCodex: async () => { probes++; } });
  assert.equal((await call(bad, 'codex_ask', { cwd, prompt: 'Consulta' })).result.isError, true);
  assert.equal(probes, 0);
});

function makeLockWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'arconte-mcp-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  return { cwd, lockDir: join(root, 'locks') };
}

test('ambos puentes comparten cerrojos, permiten lectura y recuperan un propietario huérfano', async t => {
  const { cwd, lockDir } = makeLockWorkspace(t);
  let enter; let release;
  let entered = new Promise(resolveEntered => { enter = resolveEntered; });
  let gate = new Promise(resolveGate => { release = resolveGate; });
  let heldBy = 'codex';
  const codex = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', lockDir,
    probeCodex: async () => ({ account: { type: 'chatgpt' }, modelList: {} }),
    runCodexExec: async params => {
      if (params.args.includes('workspace-write')) params.onSpawn(process.pid);
      if (heldBy === 'codex' && params.args.includes('workspace-write')) { enter(); await gate; }
      return { exitCode: 0, stdout: '', stderr: '', outputFileText: 'listo' };
    },
  });
  const claude = createClaudeCodeMcpServer({ policy: testPolicy(cwd), executable: 'claude.exe', lockDir,
    runProcess: async params => {
      if (params.args.includes('auth')) return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' };
      if (heldBy === 'claude' && params.args.includes('acceptEdits')) { enter(); await gate; }
      return { exitCode: 0, stdout: '{"result":"listo"}', stderr: '', durationMs: 1 };
    },
  });
  const activeCodex = call(codex, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' });
  await entered;
  const lockName = readdirSync(lockDir).find(name => name.endsWith('.lock'));
  const metadata = JSON.parse(readFileSync(join(lockDir, lockName), 'utf8'));
  assert.equal(metadata.pid, process.pid);
  assert.equal(metadata.childPid, process.pid);
  assert.equal(metadata.servidor, 'codex-local');
  assert.ok(!Number.isNaN(Date.parse(metadata.hora)));
  const rejectedClaude = await call(claude, 'claude_ask', { cwd, prompt: 'Editar', mode: 'edit' });
  assert.equal(rejectedClaude.result.isError, true);
  assert.match(rejectedClaude.result.content[0].text, /escritor activo/);
  assert.equal((await call(claude, 'claude_ask', { cwd, prompt: 'Leer' })).result.structuredContent.ok, true);
  release(); assert.equal((await activeCodex).result.structuredContent.ok, true);
  assert.deepEqual(readdirSync(lockDir), []);

  heldBy = 'claude';
  entered = new Promise(resolveEntered => { enter = resolveEntered; });
  gate = new Promise(resolveGate => { release = resolveGate; });
  const activeClaude = call(claude, 'claude_ask', { cwd, prompt: 'Editar', mode: 'edit' });
  await entered;
  assert.equal((await call(codex, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  assert.equal((await call(codex, 'codex_ask', { cwd, prompt: 'Leer' })).result.structuredContent.ok, true);
  release(); assert.equal((await activeClaude).result.structuredContent.ok, true);
  assert.deepEqual(readdirSync(lockDir), []);

  assert.throws(() => process.kill(2147483647, 0), error => error.code === 'ESRCH');
  writeFileSync(join(lockDir, lockName), JSON.stringify({ pid: 2147483647, childPid: process.pid, servidor: 'anterior', hora: new Date().toISOString() }));
  heldBy = null;
  assert.equal((await call(codex, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  writeFileSync(join(lockDir, lockName), JSON.stringify({ pid: 2147483647, childPid: 2147483647, servidor: 'anterior', hora: new Date().toISOString() }));
  assert.equal((await call(codex, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.structuredContent.ok, true);
  assert.deepEqual(readdirSync(lockDir), []);

  writeFileSync(join(lockDir, lockName), 'cerrojo incompleto');
  assert.equal((await call(codex, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  assert.equal(readFileSync(join(lockDir, lockName), 'utf8'), 'cerrojo incompleto');
  rmSync(join(lockDir, lockName));
  const invalidLockDir = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', lockDir: join(cwd, 'locks'),
    probeCodex: async () => ({ account: { type: 'chatgpt' }, modelList: {} }),
    runCodexExec: async () => { throw new Error('No debe escribir dentro del repositorio'); },
  });
  assert.equal((await call(invalidLockDir, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  assert.equal(existsSync(join(cwd, 'locks')), false);

  const fails = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', lockDir,
    probeCodex: async () => ({ account: { type: 'chatgpt' }, modelList: {} }),
    runCodexExec: async () => { throw new Error('fallo simulado'); },
  });
  assert.equal((await call(fails, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  assert.deepEqual(readdirSync(lockDir), []);
});

test('Codex conserva el cerrojo tras un timeout sin terminación confirmada aunque desaparezcan ambos PID', async t => {
  const { cwd, lockDir } = makeLockWorkspace(t);
  let treeTerminated = true;
  let writes = 0;
  const server = createCodexMcpServer({
    policy: testPolicy(cwd),
    executable: 'codex.exe', lockDir,
    probeCodex: async () => ({ account: { type: 'chatgpt' }, modelList: {} }),
    runCodexExec: async ({ onSpawn }) => {
      writes++;
      onSpawn(process.pid);
      return { exitCode: 124, timedOut: true, treeTerminated, stdout: '', stderr: '' };
    },
  });
  const write = () => call(server, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' });
  const confirmed = await write();
  assert.match(confirmed.result.content[0].text, /Tiempo de espera agotado/);
  assert.deepEqual(readdirSync(lockDir), []);

  treeTerminated = false;
  const timeout = await write();
  assert.equal(timeout.result.isError, true);
  assert.match(timeout.result.content[0].text, /terminación del árbol/);
  const [name] = readdirSync(lockDir);
  assert.match(name, /\.lock$/);
  const path = join(lockDir, name);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.unterminatedTree, true);
  assert.equal(record.childPid, process.pid);

  const missingPid = 2147483647;
  assert.throws(() => process.kill(missingPid, 0), { code: 'ESRCH' });
  const stale = JSON.stringify({ ...record, pid: missingPid, childPid: missingPid });
  writeFileSync(path, stale);
  const retry = await write();
  assert.equal(retry.result.isError, true);
  assert.match(retry.result.content[0].text, /escritor previo.*terminación del árbol.*limpieza manual/i);
  assert.ok(!retry.result.content[0].text.includes(lockDir), 'el mensaje no debe revelar el directorio privado de cerrojos');
  assert.equal(readFileSync(path, 'utf8'), stale);
  assert.equal(writes, 2);
});

test('marcar un árbol sin terminación confirmada respeta el token de otro propietario', async t => {
  const { cwd, lockDir } = makeLockWorkspace(t);
  const replacement = JSON.stringify({ pid: process.pid, token: 'otro-propietario' });
  let path;
  await assert.rejects(withCwdWriteLock(cwd, 'codex-local', lock => {
    path = join(lockDir, readdirSync(lockDir)[0]);
    writeFileSync(path, replacement);
    lock.markTreeUnterminated();
  }, lockDir), /ya no pertenece/);
  assert.equal(readFileSync(path, 'utf8'), replacement);
});

test('Codex maneja EPIPE de la sonda, salida acotada y timeout sin close', async t => {
  const root = mkdtempSync(join(tmpdir(), 'arconte-codex-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123; child.kill = () => true;
    return child;
  };
  await assert.rejects(defaultProbeAppServer('codex.exe', {}, root, { spawnProcess: (_exe, args) => {
    const child = fakeChild();
    if (args.includes('--version')) process.nextTick(() => { child.stdout.write('codex mock'); child.emit('close', 0); });
    else process.nextTick(() => child.stdin.emit('error', Object.assign(new Error('EPIPE simulado'), { code: 'EPIPE' })));
    return child;
  } }), /EPIPE/);
  let terminated = 0;
  const timeout = await defaultRunCodexExec({ executable: 'codex.exe', args: [], cwd: root, env: {}, timeoutMs: 20,
    spawnProcess: () => fakeChild(), terminate: async () => { terminated++; } });
  assert.equal(timeout.timedOut, true);
  assert.equal(terminated, 1);
  const large = await defaultRunCodexExec({ executable: 'codex.exe', args: [], cwd: root, env: {}, timeoutMs: 1000,
    spawnProcess: () => {
      const child = fakeChild();
      process.nextTick(() => { child.stdout.write('x'.repeat(4 * 1024 * 1024 + 100)); child.emit('close', 0); });
      return child;
    } });
  assert.equal(large.truncated, true);
  assert.equal(Buffer.byteLength(large.stdout), 4 * 1024 * 1024);
  const outputPath = join(root, 'respuesta.txt');
  writeFileSync(outputPath, 'y'.repeat(4 * 1024 * 1024 + 1));
  let registeredPid;
  const largeFile = await defaultRunCodexExec({ executable: 'codex.exe', args: [], cwd: root, env: {}, timeoutMs: 1000,
    tmpOutFile: outputPath, onSpawn: pid => { registeredPid = pid; },
    spawnProcess: () => {
      const child = fakeChild();
      process.nextTick(() => child.emit('close', 0));
      return child;
    } });
  assert.equal(registeredPid, 123);
  assert.equal(largeFile.truncated, true);
  assert.equal(Buffer.byteLength(largeFile.outputFileText), 4 * 1024 * 1024);

  let command;
  let killed = 0;
  const treeResult = await terminateProcessTree({ pid: 456, kill: () => { killed++; } }, {
    platform: 'win32', systemRoot: root, timeoutMs: 1000,
    spawnProcess: (exe, args) => {
      command = { exe, args };
      const child = new EventEmitter();
      process.nextTick(() => child.emit('exit', 0));
      return child;
    },
  });
  assert.equal(treeResult, true);
  assert.equal(command.exe, join(root, 'System32', 'taskkill.exe'));
  assert.deepEqual(command.args, ['/PID', '456', '/T', '/F']);
  assert.equal(killed, 1);
});

test('el cerrojo es exclusivo también entre procesos distintos', async t => {
  const { cwd, lockDir } = makeLockWorkspace(t);
  const repo = dirname(fileURLToPath(import.meta.url));
  const moduleUrl = pathToFileURL(join(repo, 'mcp-stdio.mjs')).href;
  const script = `const { withCwdWriteLock } = await import(process.argv[1]);
    await withCwdWriteLock(process.argv[2], 'proceso-simulado', async () => {
      process.stdout.write('tomado\\n');
      await new Promise(resolve => { process.stdin.resume(); process.stdin.once('end', resolve); });
    }, process.argv[3]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, cwd, lockDir], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* ya terminó */ } });
  child.stderr.resume();
  assert.match((await once(child.stdout, 'data'))[0].toString(), /tomado/);
  const server = createCodexMcpServer({ policy: testPolicy(cwd), executable: 'codex.exe', lockDir,
    probeCodex: async () => ({ account: { type: 'chatgpt' }, modelList: {} }),
    runCodexExec: async () => ({ exitCode: 0, stdout: '', stderr: '', outputFileText: 'listo' }),
  });
  assert.equal((await call(server, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.isError, true);
  const closed = once(child, 'close');
  child.stdin.end();
  assert.equal((await closed)[0], 0);
  assert.equal((await call(server, 'codex_ask', { cwd, prompt: 'Editar', sandbox: 'workspace-write' })).result.structuredContent.ok, true);
});

test('Codex arranca como punto de entrada con mayúsculas distintas en Windows', { skip: process.platform !== 'win32' }, async () => {
  const repo = dirname(fileURLToPath(import.meta.url));
  const script = join(repo, 'codex-mcp-server.mjs').replace(/\.mjs$/, '').toUpperCase() + '.mjs';
  const child = spawn(process.execPath, [script], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const code = await new Promise(resolveExit => child.once('close', resolveExit));
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output.trim()).result, {});
});
