import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('CLI grant and revoke persist confirmed grants for daemon authorization', async () => {
  const grant = { projectId: 'project-a', threadId: 'thread-a', connectorId: 'connector-a' };
  const otherProject = { ...grant, projectId: 'project-b' };
  let grants: any[] = [otherProject];
  let version = 'v1';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (code: number, data: unknown) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ protocol: 'hc/1', requestId: 'r'.repeat(32), data }));
    };
    if (req.url === '/v1/bindings/binding-a/task-grants' && req.method === 'GET') return json(200, { grants, grantsVersion: version });
    if (req.url === '/v1/bindings/binding-a/task-grants' && req.method === 'PUT') {
      const input = JSON.parse(body);
      grants = input.grants;
      version = `v${Number(version.slice(1)) + 1}`;
      return json(200, { grants, grantsVersion: version });
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const dir = await mkdtemp(join(tmpdir(), 'hc-grants-'));
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, connectorId: 'connector-a', token: 'token-a', bindingId: 'binding-a' }));
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
    const base = ['--config', config];
    const ref = JSON.stringify(grant);
    await run(process.execPath, [cli, 'task', 'grant', '--ref', ref, ...base]);
    let stored = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(stored.grants, [otherProject, grant]);
    assert.equal(stored.grantsVersion, 'v2');
    await run(process.execPath, [cli, 'task', 'revoke', '--ref', ref, ...base]);
    stored = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(stored.grants, [otherProject]);
    assert.equal(stored.grantsVersion, 'v3');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
