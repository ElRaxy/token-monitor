'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createWindowReplacementQueue,
  mergeWindowReplacementPlans,
  startWindowReplacementLifecycle,
} = require('../../src/electron/windowReplacement');

function mockWindow(visible = false) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isVisible = () => visible;
  return win;
}

test('a newer replacement cancels the active transaction and starts immediately', () => {
  const starts = [];
  const queue = createWindowReplacementQueue((options, complete) => {
    const entry = { options, complete, cancelled: null };
    starts.push(entry);
    return (reason) => {
      entry.cancelled = reason;
      complete();
    };
  });

  assert.equal(queue.request({ id: 'first' }), true);
  assert.equal(queue.request({ id: 'latest' }), false);
  assert.deepEqual(starts.map((entry) => entry.options.id), ['first', 'latest']);
  assert.deepEqual(starts[0].cancelled, { superseded: true });
  assert.equal(queue.active, true);

  starts[1].complete();
  assert.equal(queue.active, false);
});

test('pending requests coalesce to the latest plan until an uncancellable transaction settles', () => {
  const starts = [];
  const queue = createWindowReplacementQueue((options, complete) => {
    starts.push({ options, complete });
  });

  queue.request({ id: 'first' });
  queue.request({ id: 'second' });
  queue.request({ id: 'latest' });
  assert.deepEqual(starts.map((entry) => entry.options.id), ['first']);

  starts[0].complete();
  assert.deepEqual(starts.map((entry) => entry.options.id), ['first', 'latest']);
  starts[1].complete();
  assert.equal(queue.active, false);
});

test('custom coalescing preserves rebuild hints without duplicating completion', () => {
  const starts = [];
  const queue = createWindowReplacementQueue(
    (options, complete) => { starts.push({ options, complete }); },
    (previous, next) => ({ ...previous, ...next, focus: previous.focus || next.focus }),
  );

  queue.request({ id: 'first' });
  queue.request({ id: 'second', focus: true });
  queue.request({ id: 'latest' });
  starts[0].complete();
  starts[0].complete();
  assert.deepEqual(starts[1].options, { id: 'latest', focus: true });
  assert.equal(starts.length, 2);
});

test('a floating-bubble plan preserves the active rebuild rollback intent', () => {
  const starts = [];
  const queue = createWindowReplacementQueue((options, complete) => {
    const entry = { options, complete };
    starts.push(entry);
    return () => complete();
  }, mergeWindowReplacementPlans);

  queue.request({
    kind: 'rebuild',
    focus: true,
    createOptions: { settingsSection: 'window', waitForContent: true },
  });
  queue.request({
    kind: 'floating-bubble',
    focus: false,
    createOptions: { collapsedFloatingBubble: true, waitForContent: false },
  });

  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].options, {
    kind: 'rebuild',
    focus: false,
    createOptions: {
      collapsedFloatingBubble: true,
      waitForContent: false,
      settingsSection: 'window',
    },
  });
  starts[1].complete();
});

test('coalesced rebuilds preserve an earlier Settings section', () => {
  assert.deepEqual(mergeWindowReplacementPlans({
    kind: 'rebuild',
    focus: true,
    createOptions: { settingsSection: 'window', waitForContent: true },
  }, {
    kind: 'rebuild',
    focus: false,
    createOptions: { settingsSection: undefined, suppressInitialNumberAnimation: true },
  }), {
    kind: 'rebuild',
    focus: true,
    createOptions: {
      settingsSection: 'window',
      waitForContent: true,
      suppressInitialNumberAnimation: true,
    },
  });
});

test('load failure rolls a candidate back without committing it', () => {
  const win = mockWindow();
  const calls = [];
  let settleLoad;
  startWindowReplacementLifecycle({
    createCandidate: (onLoadSettled) => {
      settleLoad = onLoadSettled;
      return { win };
    },
    onCommit: () => calls.push('commit'),
    onRollback: (_candidate, details) => calls.push(details.reason),
  }, () => calls.push('complete'));

  settleLoad({ ok: false, error: new Error('failed') });
  win.emit('show');
  assert.deepEqual(calls, ['load-failed', 'complete']);
});

test('visible replacements require both a successful load and a show event', () => {
  const win = mockWindow();
  const calls = [];
  let settleLoad;
  startWindowReplacementLifecycle({
    createCandidate: (onLoadSettled) => {
      settleLoad = onLoadSettled;
      return { win };
    },
    onCommit: () => calls.push('commit'),
    onRollback: () => calls.push('rollback'),
  }, () => calls.push('complete'));

  settleLoad({ ok: true });
  assert.deepEqual(calls, []);
  win.emit('show');
  win.emit('closed');
  assert.deepEqual(calls, ['commit', 'complete']);
});

test('hidden replacements commit after load without being shown', () => {
  const win = mockWindow();
  const calls = [];
  let settleLoad;
  startWindowReplacementLifecycle({
    hidden: true,
    createCandidate: (onLoadSettled) => {
      settleLoad = onLoadSettled;
      return { win };
    },
    onCommit: () => calls.push('commit'),
  }, () => calls.push('complete'));

  settleLoad({ ok: true });
  assert.deepEqual(calls, ['commit', 'complete']);
});

test('superseding a pending lifecycle rolls it back once', () => {
  const win = mockWindow();
  const calls = [];
  const cancel = startWindowReplacementLifecycle({
    createCandidate: () => ({ win }),
    onCommit: () => calls.push('commit'),
    onRollback: (_candidate, details) => calls.push(details.reason),
  }, () => calls.push('complete'));

  cancel({ superseded: true });
  win.emit('show');
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(calls, ['superseded', 'complete']);
});
