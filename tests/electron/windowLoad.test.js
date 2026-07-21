'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { observeWindowLoad } = require('../../src/electron/windowLoad');

test('resolved loadFile promises settle successfully', async () => {
  const results = [];
  const result = await observeWindowLoad(Promise.resolve(), {
    onSettled: (value) => results.push(value),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(results, [{ ok: true }]);
});

test('rejected loadFile promises roll back before normal error handling', async () => {
  const error = new Error('renderer unavailable');
  const order = [];
  const result = await observeWindowLoad(Promise.reject(error), {
    onSettled: (value) => order.push(['settled', value]),
    onRejected: (value) => order.push(['rejected', value]),
  });
  assert.deepEqual(result, { ok: false, error });
  assert.deepEqual(order, [
    ['settled', { ok: false, error }],
    ['rejected', error],
  ]);
});
