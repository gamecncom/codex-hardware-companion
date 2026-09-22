import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAuthorizedGrant, taskRefMatches } from '../src/authorization.js';

test('authorization requires complete TaskRef match', () => {
  const target = { projectId: 'p1', threadId: 't1', connectorId: 'c1' };
  assert.equal(taskRefMatches(target, target), true);
  assert.equal(taskRefMatches(target, { ...target, projectId: 'p2' }), false);
  assert.equal(taskRefMatches(target, { ...target, connectorId: 'c2' }), false);
  assert.equal(hasAuthorizedGrant([{ ...target, projectId: 'p2' }], target), false);
  assert.equal(hasAuthorizedGrant([target], target), true);
});
