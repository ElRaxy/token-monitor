'use strict';

// BrowserWindow replacement is asynchronous. Keep one transaction in flight
// and coalesce later requests so two rapid settings changes cannot each destroy
// the window the other transaction expects to roll back to.
function createWindowReplacementQueue(startReplacement, mergeQueued = (_previous, next) => next) {
  let activeTransaction = null;
  let queuedOptions = null;

  const start = (options) => {
    const transaction = { cancel: null, completed: false, superseded: false, options };
    activeTransaction = transaction;
    let completed = false;
    const complete = () => {
      if (completed) return false;
      completed = true;
      transaction.completed = true;
      if (activeTransaction === transaction) activeTransaction = null;
      const nextOptions = queuedOptions;
      queuedOptions = null;
      if (nextOptions) start(nextOptions);
      return true;
    };

    try {
      const cancel = startReplacement(options, complete);
      transaction.cancel = typeof cancel === 'function' ? cancel : null;
      if (transaction.superseded && !transaction.completed) transaction.cancel?.({ superseded: true });
    } catch (error) {
      complete();
      throw error;
    }
  };

  return {
    request(options = {}) {
      if (activeTransaction) {
        queuedOptions = mergeQueued(queuedOptions || activeTransaction.options, options);
        activeTransaction.superseded = true;
        activeTransaction.cancel?.({ superseded: true });
        return false;
      }
      start({ ...options });
      return true;
    },
    get active() {
      return Boolean(activeTransaction);
    },
  };
}

function mergeWindowReplacementPlans(previous = {}, next = {}) {
  if (previous.kind === 'rebuild' && next.kind === 'rebuild') {
    return {
      ...next,
      focus: previous.focus === true || next.focus === true ? true : next.focus,
      createOptions: { ...previous.createOptions, ...next.createOptions },
    };
  }
  if (previous.kind !== 'rebuild' || next.kind === 'rebuild') return { ...next };

  const settingsSection = next.createOptions?.settingsSection
    || previous.createOptions?.settingsSection;
  return {
    ...next,
    // The latest plan still owns the candidate shape and focus behavior, but
    // its failure must roll immutable chrome settings back to the committed
    // window when it superseded a pending rebuild.
    kind: 'rebuild',
    createOptions: {
      ...next.createOptions,
      ...(settingsSection ? { settingsSection } : {}),
    },
  };
}

function startWindowReplacementLifecycle(options, complete) {
  let candidate = null;
  let win = null;
  let settled = false;
  let loaded = false;
  let shown = false;
  let pendingLoadResult = null;

  const cleanup = () => {
    if (!win) return;
    win.removeListener('show', onShow);
    win.removeListener('closed', onClosed);
    win.removeListener('unresponsive', onUnresponsive);
    win.webContents?.removeListener('render-process-gone', onRendererGone);
  };
  const settle = (commit, details = {}) => {
    if (settled) return false;
    settled = true;
    cleanup();
    try {
      if (commit) options.onCommit?.(candidate);
      else options.onRollback?.(candidate, details);
    } catch (error) {
      options.onError?.(error);
    } finally {
      complete();
    }
    return true;
  };
  const maybeCommit = () => {
    if (!loaded) return;
    if (options.hidden === true || shown) settle(true);
  };
  const onShow = () => {
    shown = true;
    maybeCommit();
  };
  const onClosed = () => settle(false, { reason: 'closed' });
  const onUnresponsive = () => settle(false, { reason: 'unresponsive' });
  const onRendererGone = (_event, details) => settle(false, {
    reason: 'renderer-gone',
    rendererReason: details?.reason,
  });
  const onLoadSettled = (result) => {
    if (!win) {
      pendingLoadResult = result;
      return;
    }
    if (!result.ok) {
      settle(false, { reason: 'load-failed', error: result.error });
      return;
    }
    loaded = true;
    maybeCommit();
  };

  try {
    candidate = options.createCandidate(onLoadSettled);
    win = candidate?.win || candidate;
    if (!win) throw new Error('Window replacement did not create a candidate');
  } catch (error) {
    options.onError?.(error);
    settle(false, { reason: 'create-failed', error });
    return null;
  }

  shown = win.isVisible();
  win.on('show', onShow);
  win.once('closed', onClosed);
  win.once('unresponsive', onUnresponsive);
  win.webContents?.once('render-process-gone', onRendererGone);
  if (pendingLoadResult) onLoadSettled(pendingLoadResult);
  else maybeCommit();

  return (reason = {}) => settle(false, {
    reason: reason.superseded ? 'superseded' : 'cancelled',
  });
}

module.exports = {
  createWindowReplacementQueue,
  mergeWindowReplacementPlans,
  startWindowReplacementLifecycle,
};
