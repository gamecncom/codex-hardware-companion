import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveInstallAsset } from '../src/install-assets.js';

test('serves only immutable versioned installer assets without affecting other routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hc-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'v0.3.9'));
  await writeFile(join(root, 'v0.3.9', 'sample.tar.gz'), 'release bytes');
  const server = createServer(async (req, res) => {
    if (!await serveInstallAsset(req, res, new URL(req.url ?? '/', 'http://localhost').pathname, root)) {
      res.writeHead(204); res.end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const asset = await fetch(`${base}/v1/install/v0.3.9/sample.tar.gz`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await asset.text(), 'release bytes');
  const head = await fetch(`${base}/v1/install/v0.3.9/sample.tar.gz`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '13');
  assert.equal((await fetch(`${base}/v1/install/v0.3.9/../secret.tar.gz`)).status, 404);
  assert.equal((await fetch(`${base}/v1/install/v0.3.9/missing.tar.gz`)).status, 404);
  assert.equal((await fetch(`${base}/v1/device/state`)).status, 204);
});
