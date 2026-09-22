import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClientRequestId, assertId, byteLength } from '../src/index.js';
import { fixtureCatalog } from '../src/fixtures.js';

test('fixture has stable TaskRef IDs and two projects', () => { assert.equal(fixtureCatalog.projects.length, 2); assert.equal(fixtureCatalog.tasks[0].threadId, 'thread-a'); });
test('UTF-8 byte limits are measured in bytes', () => { assert.equal(byteLength('中'), 3); assert.throws(() => assertId('中'.repeat(43))); });
test('client request IDs are exact lowercase/uppercase hex', () => { assert.doesNotThrow(() => assertClientRequestId('00112233445566778899aAbBcCdDeEfF')); assert.throws(() => assertClientRequestId('short')); });
