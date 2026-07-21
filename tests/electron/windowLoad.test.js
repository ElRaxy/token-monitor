'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { isAbortedNavigation, observeWindowLoad } = require('../../src/electron/windowLoad');

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

test('aborted navigation waits for the replacement main frame to finish', async () => {
  const webContents = new EventEmitter();
  const error = Object.assign(new Error('ERR_ABORTED (-3) loading index.html'), { errno: -3 });
  const results = [];
  const observed = observeWindowLoad(Promise.reject(error), {
    webContents,
    onSettled: (value) => results.push(value),
  });

  await Promise.resolve();
  assert.deepEqual(results, []);
  assert.equal(webContents.listenerCount('did-finish-load'), 1);
  webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true);
  assert.deepEqual(results, []);
  webContents.emit('did-finish-load');

  assert.deepEqual(await observed, { ok: true });
  assert.deepEqual(results, [{ ok: true }]);
  assert.equal(webContents.listenerCount('did-finish-load'), 0);
  assert.equal(webContents.listenerCount('did-fail-load'), 0);
});

test('a real main-frame failure after an abort settles as a failure', async () => {
  const webContents = new EventEmitter();
  const aborted = Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' });
  const rejected = [];
  const observed = observeWindowLoad(Promise.reject(aborted), {
    webContents,
    onRejected: (error) => rejected.push(error),
  });

  await Promise.resolve();
  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', false);
  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', true);
  const result = await observed;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, -105);
  assert.equal(result.error.message, 'NAME_NOT_RESOLVED');
  assert.deepEqual(rejected, [result.error]);
});

test('aborted-navigation detection covers Electron error shapes', () => {
  assert.equal(isAbortedNavigation({ code: 'ERR_ABORTED' }), true);
  assert.equal(isAbortedNavigation({ code: -3 }), true);
  assert.equal(isAbortedNavigation({ errno: -3 }), true);
  assert.equal(isAbortedNavigation(new Error('ERR_ABORTED (-3) loading index.html')), true);
  assert.equal(isAbortedNavigation({ code: 'ERR_FAILED', errno: -2 }), false);
});
