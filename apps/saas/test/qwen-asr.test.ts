import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QwenAsr } from '../src/qwen-asr.js';

async function requestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('Qwen ASR fixture validates policy, OSS multipart, async polling, and transcript extraction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-'));
  const file = join(root, 'recording.m4a');
  const audio = Buffer.from('synthetic-audio-bytes');
  await writeFile(file, audio);
  const apiKey = 'fixture-api-key';
  const model = 'fixture-model';
  const keys = new Set<string>();
  let submitCount = 0;
  const pollCounts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const base = `http://${req.headers.host}`;
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/api/v1/uploads') {
      assert.equal(url.searchParams.get('action'), 'getPolicy');
      assert.equal(url.searchParams.get('model'), model);
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      assert.match(req.headers['content-type'] ?? '', /application\/json/);
      return json(200, { data: {
        upload_host: `${base}/oss`, upload_dir: 'fixture-dir', oss_access_key_id: 'access-key',
        signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
      } });
    }
    if (req.method === 'POST' && url.pathname === '/oss') {
      const body = await requestBody(req);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? '']));
      const form = await new Request(`${base}${url.pathname}`, { method: 'POST', headers, body }).formData();
      for (const [field, expected] of Object.entries({
        OSSAccessKeyId: 'access-key', Signature: 'signature', policy: 'policy',
        'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', success_action_status: '200',
      })) assert.equal(form.get(field), expected);
      const key = form.get('key');
      assert.equal(typeof key, 'string');
      assert.match(key as string, /^fixture-dir\/[0-9a-f-]{36}-recording\.m4a$/);
      assert.equal(keys.has(key as string), false, 'each upload must use a unique OSS key');
      keys.add(key as string);
      const uploaded = form.get('file');
      assert.ok(uploaded instanceof Blob);
      assert.deepEqual(Buffer.from(await (uploaded as Blob).arrayBuffer()), audio);
      assert.equal((uploaded as File).name, 'recording.m4a');
      return json(200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/services/audio/asr/transcription') {
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(req.headers['x-dashscope-async'], 'enable');
      assert.equal(req.headers['x-dashscope-ossresourceresolve'], 'enable');
      const payload = JSON.parse((await requestBody(req)).toString('utf8'));
      assert.deepEqual(Object.keys(payload).sort(), ['input', 'model']);
      assert.equal(payload.model, model);
      assert.match(payload.input.file_url, /^oss:\/\/fixture-dir\/[0-9a-f-]{36}-recording\.m4a$/);
      submitCount++;
      return json(200, { output: { task_id: `task-${submitCount}` } });
    }
    const task = /^\/api\/v1\/tasks\/(task-[0-9]+)$/.exec(url.pathname);
    if (req.method === 'GET' && task) {
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      const taskId = task[1];
      const count = (pollCounts.get(taskId) ?? 0) + 1;
      pollCounts.set(taskId, count);
      if (taskId === 'task-1') return count === 1
        ? json(200, { output: { task_status: 'PENDING' } })
        : json(200, { output: { task_status: 'SUCCEEDED', result: { transcription_url: `${base}/result/success` } } });
      if (taskId === 'task-2') return json(200, { output: { task_status: 'FAILED' } });
      return json(200, { output: { task_status: 'SUCCEEDED', result: { transcription_url: `${base}/result/empty` } } });
    }
    if (req.method === 'GET' && url.pathname === '/result/success') return json(200, { transcripts: [{ text: '你好' }, { text: '世界' }] });
    if (req.method === 'GET' && url.pathname === '/result/empty') return json(200, { transcripts: [{ text: '  ' }] });
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const asr = new QwenAsr({ apiKey, model, baseURL, pollIntervalMs: 1, maxPolls: 5 });
  assert.deepEqual(await asr.transcribe(file), { providerTaskId: 'task-1', transcript: '你好 世界' });
  await assert.rejects(() => asr.transcribe(file), /ASR_FAILED/);
  await assert.rejects(() => asr.transcribe(file), /ASR_FAILED/);
  assert.equal(submitCount, 3);
  assert.equal((await readFile(file)).toString(), audio.toString());
});
