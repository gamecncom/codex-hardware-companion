import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { createDeviceView, migrateDeviceViews, readDeviceJpeg } from '../src/pg-device-view.js';

test('PG transcript view paginates ready UTF-8 drafts, caps JPEGs, and isolates bindings', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const db = new PostgresStore(url);
  t.after(() => db.close());
  const repo = new PgBusinessRepository(db);
  await repo.migrate();
  await migrateDeviceViews(db);
  const suffix = randomUUID();
  const connectorId = `transcript-connector-${suffix}`;
  const binding = await repo.createBinding(`transcript-user-${suffix}`, connectorId, `transcript-device-${suffix}`, `transcript-token-${suffix}`);
  const other = await repo.createBinding(`transcript-other-${suffix}`, connectorId, `transcript-other-device-${suffix}`, `transcript-other-token-${suffix}`);
  const recordingId = `rec-${suffix}`;
  const target = { connectorId, projectId: `transcript-project-${suffix}`, threadId: `transcript-thread-${suffix}` };
  const transcript = '你好，Hardware Companion 录音确认正文。'.repeat(70);
  assert.ok(Buffer.byteLength(transcript, 'utf8') <= 4096);
  await db.pool.query(`INSERT INTO hc_recordings(id,binding_id,binding_epoch,selection_revision,target,client_request_id,audio,status,transcript)
    VALUES($1,$2,1,'3',$3,$4,decode('00','hex'),'ready',$5)`, [recordingId, binding.id, JSON.stringify(target), 'c'.repeat(32), transcript]);
  await db.pool.query(`INSERT INTO hc_recordings(id,binding_id,binding_epoch,selection_revision,target,client_request_id,audio,status,transcript)
    VALUES($1,$2,1,'3',$3,$4,decode('00','hex'),$5,$6),($7,$2,1,'3',$3,$4,decode('00','hex'),'failed',NULL),($8,$2,1,'3',$3,$4,decode('00','hex'),'cancelled',NULL)`,
    [`processing-${suffix}`, binding.id, JSON.stringify(target), 'd'.repeat(32), 'processing', null, `failed-${suffix}`, `cancelled-${suffix}`]);
  const descriptors: any[] = [];
  let page = 0;
  for (;;) {
    const descriptor = await createDeviceView(db, 'transcript-token-' + suffix, { kind: 'transcript', recordingId, page });
    descriptors.push(descriptor);
    assert.equal(descriptor.recordingId, recordingId);
    assert.deepEqual(descriptor.target, target);
    assert.equal(descriptor.page, page);
    const pageCount = descriptor.pageCount!;
    assert.ok(pageCount > 1);
    assert.deepEqual(descriptor.items.map((item: any) => item.action), ['confirm', 'cancel']);
    const jpeg = await readDeviceJpeg(db, 'transcript-token-' + suffix, descriptor.viewId);
    assert.ok(jpeg.length <= 150 * 1024);
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 320);
    if (++page >= pageCount) break;
  }
  assert.equal(descriptors.length, descriptors[0].pageCount);
  assert.equal(descriptors.map((descriptor) => descriptor.textLines.join('')).join(''), transcript);
  await assert.rejects(() => createDeviceView(db, 'transcript-token-' + suffix, { kind: 'transcript', recordingId: `processing-${suffix}` }), /RECORDING_NOT_READY/);
  await assert.rejects(() => createDeviceView(db, 'transcript-token-' + suffix, { kind: 'transcript', recordingId: `failed-${suffix}` }), /RECORDING_NOT_READY/);
  await assert.rejects(() => createDeviceView(db, 'transcript-token-' + suffix, { kind: 'transcript', recordingId: `cancelled-${suffix}` }), /RECORDING_NOT_READY/);
  await assert.rejects(() => createDeviceView(db, 'transcript-other-token-' + suffix, { kind: 'transcript', recordingId }), /NOT_FOUND|UNAUTHORIZED/);
  await assert.rejects(() => createDeviceView(db, 'transcript-token-' + suffix, { kind: 'transcript', recordingId: `missing-${suffix}` }), /NOT_FOUND/);
  void other;
});
