import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('CLI init, device use, grant, and select preserve connector-owned IDs and revisions', async () => {
  const connectorId = 'connector-original';
  const deviceId = 'device-original';
  const bindingId = 'binding-original';
  const target = { connectorId, projectId: 'project-original', threadId: 'thread-original' };
  let grants: any[] = [];
  let grantsVersion = '0';
  let selectionRevision = '7';
  const seen: { method: string; path: string; authorization?: string; body?: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    seen.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body: parsed });
    const json = (code: number, data: unknown) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ protocol: 'hc/1', requestId: 'r'.repeat(32), data }));
    };
    if (req.method === 'POST' && req.url === '/v1/auth/email/start') return json(200, { status: 'sent' });
    if (req.method === 'POST' && req.url === '/v1/auth/email/verify') return json(200, { sessionToken: 'session-original' });
    if (req.method === 'POST' && req.url === '/v1/connectors/register') {
      assert.equal(req.headers.authorization, 'Bearer session-original');
      return json(200, { connectorId, token: 'connector-token-original' });
    }
    if (req.method === 'GET' && req.url === '/v1/devices') {
      assert.equal(req.headers.authorization, 'Bearer connector-token-original');
      return json(200, [{ deviceId, bindingId, connectorId, state: 'active', selectionRevision }]);
    }
    if (req.method === 'GET' && req.url === `/v1/bindings/${bindingId}/task-grants`) {
      assert.equal(req.headers.authorization, 'Bearer connector-token-original');
      return json(200, { grants, grantsVersion });
    }
    if (req.method === 'PUT' && req.url === `/v1/bindings/${bindingId}/task-grants`) {
      assert.equal(req.headers.authorization, 'Bearer connector-token-original');
      assert.equal(parsed.expectedGrantsVersion, grantsVersion);
      grants = parsed.grants;
      grantsVersion = '1';
      return json(200, { grants, grantsVersion });
    }
    if (req.method === 'POST' && req.url === '/v1/device/selection') {
      assert.equal(req.headers.authorization, 'Bearer connector-token-original');
      assert.equal(parsed.bindingId, bindingId);
      assert.deepEqual(parsed.target, target);
      assert.equal(parsed.expectedSelectionRevision, selectionRevision);
      selectionRevision = '8';
      return json(200, { activeTaskRef: target, selectionRevision });
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const dir = await mkdtemp(join(tmpdir(), 'hc-device-use-'));
    const config = join(dir, 'config.json');
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
    const base = ['--config', config, '--base-url', `http://127.0.0.1:${port}`];
    await run(process.execPath, [cli, 'init', '--email', 'user@example.com', ...base]);
    await run(process.execPath, [cli, 'init', '--email', 'user@example.com', '--code', '123456', ...base]);
    const used = await run(process.execPath, [cli, 'device', 'use', '--device', deviceId, ...base]);
    assert.equal(JSON.parse(used.stdout).data.bindingId, bindingId);
    let stored = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(stored.bindingId, bindingId);
    assert.equal(stored.selectionRevision, '7');
    assert.deepEqual(stored.grants, []);
    assert.equal(stored.grantsVersion, '0');
    assert.equal('deviceToken' in stored, false);

    await run(process.execPath, [cli, 'task', 'grant', '--ref', JSON.stringify(target), ...base]);
    stored = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(stored.grants, [target]);
    assert.equal(stored.grantsVersion, '1');
    await run(process.execPath, [cli, 'task', 'select', '--ref', JSON.stringify(target), ...base]);
    stored = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(stored.selectionRevision, '8');
    assert.ok(seen.some((request) => request.path === '/v1/device/selection' && request.body.target.threadId === 'thread-original'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
