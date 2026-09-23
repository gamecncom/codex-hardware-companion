import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePairingDigits, voicePair } from '../src/pg-v03.js';

test('v0.3 voice pairing normalizes exact eight digits and preserves leading zero', () => {
  assert.equal(normalizePairingDigits('零一二三四五六七'), '01234567');
  assert.equal(normalizePairingDigits('01 23-4567'), '01234567');
  assert.equal(normalizePairingDigits('六三三八零七幺幺。'), '63380711');
  assert.equal(normalizePairingDigits('６３３８０７１１。'), '63380711');
  assert.equal(normalizePairingDigits('1234567'), undefined);
  assert.equal(normalizePairingDigits('123456789'), undefined);
  assert.equal(normalizePairingDigits('一二三四五六七八九'), undefined);
});

test('v0.3 voice pairing starts ASR asynchronously and de-duplicates retries', async () => {
  let row: any;
  let asrCalls = 0;
  const db: any = {
    transaction: async (fn: (client: any) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        if (sql.startsWith('SELECT * FROM hc_voice_pairing_attempts')) return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
        if (sql.startsWith('INSERT INTO hc_voice_pairing_attempts')) {
          row = { id: 'vpa-test', device_id: 'device-test', status: 'processing' };
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    }),
    pool: {
      query: async (sql: string) => {
        if (sql.startsWith('UPDATE hc_voice_pairing_attempts')) row.status = 'no_match';
        return { rowCount: 1, rows: [] };
      },
    },
  };
  const asr = { kind: 'fixture', transcribe: async () => { asrCalls += 1; return { transcript: 'not a code' }; } };
  const requestId = '0123456789abcdef0123456789abcdef';
  const first = await voicePair(db, asr, 'bootstrap', 'device-test', requestId, Buffer.from('audio'));
  assert.equal(first.status, 'processing');
  assert.match(first.pairingAttemptId, /^vpa-/);
  for (let i = 0; i < 20 && asrCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(asrCalls, 1);
  const retry = await voicePair(db, asr, 'bootstrap', 'device-test', requestId, Buffer.from('audio'));
  assert.equal(retry.status, 'no_match');
  assert.equal(asrCalls, 1);
});
