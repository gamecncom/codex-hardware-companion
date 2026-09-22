import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('background-service preview starts persistent daemon, not a status command', () => {
  const output = execFileSync(process.execPath, ['apps/connector/scripts/install-launchagent.mjs'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, HC_CONNECTOR_PROGRAM: '/fixture/bin/companion' },
  });
  const result = JSON.parse(output);
  assert.equal(result.loaded, false, 'preview must not install a service');
  assert.match(result.plist, /<string>daemon<\/string>/);
  assert.match(result.plist, /<string>start<\/string>/);
  assert.doesNotMatch(result.plist, /<string>status<\/string>/);
});
