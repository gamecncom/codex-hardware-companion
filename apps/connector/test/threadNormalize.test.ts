import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThread } from '../src/threadNormalize.js';

const snapshot = (status:string, turns:any[]) => ({ threadId: 'thread', cwd: '/fixture', status, turns, raw: {} } as any);
const turn = (id:string, status:string) => ({ id, status, items: [] });

test('uses the latest Codex turn when thread status is notLoaded', () => {
  assert.equal(normalizeThread(snapshot('notLoaded', [turn('old', 'completed'), turn('latest', 'completed')])).status, 'completed');
  assert.equal(normalizeThread(snapshot('unknown', [turn('latest', 'failed')])).status, 'failed');
  assert.equal(normalizeThread(snapshot('idle', [turn('latest', 'inProgress')])).status, 'running');
  assert.equal(normalizeThread(snapshot('unknown', [turn('latest', 'interrupted')])).status, 'failed');
});

test('uses a completed latest turn when the thread status is stale failed', () => {
  assert.equal(normalizeThread(snapshot('failed', [turn('latest', 'completed')])).status, 'completed');
});

test('keeps a live thread status ahead of a stale turn status', () => {
  assert.equal(normalizeThread(snapshot('running', [turn('latest', 'completed')])).status, 'running');
  assert.equal(normalizeThread(snapshot('waiting_user', [turn('latest', 'completed')])).status, 'waiting_user');
});

test('does not infer a new status from an older turn', () => {
  assert.equal(normalizeThread(snapshot('unknown', [turn('old', 'running'), turn('latest', '')])).status, 'unknown');
});
