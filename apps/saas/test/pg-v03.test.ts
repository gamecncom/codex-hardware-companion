import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePairingDigits } from '../src/pg-v03.js';

test('v0.3 voice pairing normalizes exact eight digits and preserves leading zero', () => {
  assert.equal(normalizePairingDigits('零一二三四五六七'), '01234567');
  assert.equal(normalizePairingDigits('01 23-4567'), '01234567');
  assert.equal(normalizePairingDigits('1234567'), undefined);
  assert.equal(normalizePairingDigits('123456789'), undefined);
  assert.equal(normalizePairingDigits('一二三四五六七八九'), undefined);
});
