'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { observeMainFrameLoad } = require('../../src/electron/windowLoad');

test('main-frame load failures settle once and remove observers', () => {
  const webContents = new EventEmitter();
  const results = [];
  observeMainFrameLoad(webContents, (result) => results.push(result));

  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', false);
  webContents.emit('did-fail-load', {}, -3, 'ABORTED', '', true);
  assert.deepEqual(results, []);

  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', true);
  webContents.emit('did-finish-load');
  assert.deepEqual(results, [{ ok: false, errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED' }]);
  assert.equal(webContents.listenerCount('did-fail-load'), 0);
  assert.equal(webContents.listenerCount('did-finish-load'), 0);
});

test('successful main-frame loads settle once and remove observers', () => {
  const webContents = new EventEmitter();
  const results = [];
  observeMainFrameLoad(webContents, (result) => results.push(result));

  webContents.emit('did-finish-load');
  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', true);
  assert.deepEqual(results, [{ ok: true }]);
  assert.equal(webContents.listenerCount('did-fail-load'), 0);
  assert.equal(webContents.listenerCount('did-finish-load'), 0);
});
