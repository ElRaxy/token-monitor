'use strict';

function isAbortedNavigation(error) {
  return error?.code === 'ERR_ABORTED'
    || error?.code === -3
    || error?.errno === -3
    || /ERR_ABORTED/.test(String(error?.message || ''));
}

function observeWindowLoad(loadPromise, handlers = {}) {
  const webContents = handlers.webContents;
  let settled = false;
  let waitingAfterAbort = false;
  let finishedBeforeAbortHandler = false;
  let abortedError = null;
  let abortTimer = null;

  return new Promise((resolve) => {
    const cleanup = () => {
      if (abortTimer) clearTimeout(abortTimer);
      abortTimer = null;
      webContents?.removeListener('did-finish-load', onFinished);
      webContents?.removeListener('did-fail-load', onFailed);
      webContents?.removeListener('destroyed', onDestroyed);
    };
    const settle = (result) => {
      if (settled) return false;
      settled = true;
      cleanup();
      // Roll replacement windows back before the normal load-error handler
      // tries to reveal the failed candidate.
      handlers.onSettled?.(result);
      if (!result.ok) handlers.onRejected?.(result.error);
      resolve(result);
      return true;
    };
    const onFinished = () => {
      if (waitingAfterAbort) settle({ ok: true });
      else finishedBeforeAbortHandler = true;
    };
    const onFailed = (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || !waitingAfterAbort) return;
      const error = new Error(errorDescription || `Window load failed (${errorCode})`);
      error.code = errorCode;
      settle({ ok: false, error });
    };
    const onDestroyed = () => {
      if (!waitingAfterAbort) return;
      settle({ ok: false, error: abortedError });
    };

    webContents?.on('did-finish-load', onFinished);
    webContents?.on('did-fail-load', onFailed);
    webContents?.on('destroyed', onDestroyed);
    Promise.resolve(loadPromise).then(
      () => settle({ ok: true }),
      (error) => {
        if (isAbortedNavigation(error) && webContents) {
          waitingAfterAbort = true;
          abortedError = error;
          if (webContents.isDestroyed?.()) settle({ ok: false, error });
          else if (finishedBeforeAbortHandler) settle({ ok: true });
          else {
            const timeoutMs = Number.isFinite(handlers.abortTimeoutMs)
              ? Math.max(0, handlers.abortTimeoutMs)
              : 5000;
            abortTimer = setTimeout(() => settle({ ok: false, error }), timeoutMs);
          }
          return;
        }
        settle({ ok: false, error });
      },
    );
  });
}

module.exports = { isAbortedNavigation, observeWindowLoad };
