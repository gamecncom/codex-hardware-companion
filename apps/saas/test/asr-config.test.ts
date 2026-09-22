import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsrAdapter } from '../src/asr.js';

test('production config constructs Qwen only with explicit provider and key', () => {
  const adapter = createAsrAdapter({ NODE_ENV: 'production', ASR_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'synthetic-key' });
  assert.equal(adapter.kind, 'qwen3-asr-flash-filetrans');
  assert.throws(() => createAsrAdapter({ NODE_ENV: 'production', ASR_PROVIDER: 'qwen' }), /DASHSCOPE_API_KEY/);
  assert.throws(() => createAsrAdapter({ NODE_ENV: 'production', ASR_PROVIDER: 'test' }), /cannot use a fake/);
});
