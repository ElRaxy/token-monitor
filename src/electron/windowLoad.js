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

  return new Promise((resolve) => {
    const cleanup = () => {
      webContents?.removeListener('did-finish-load', onFinished);
      webContents?.removeListener('did-fail-load', onFailed);
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

    webContents?.on('did-finish-load', onFinished);
    webContents?.on('did-fail-load', onFailed);
    Promise.resolve(loadPromise).then(
      () => settle({ ok: true }),
      (error) => {
        if (isAbortedNavigation(error) && webContents) {
          waitingAfterAbort = true;
          if (finishedBeforeAbortHandler) settle({ ok: true });
          return;
        }
        settle({ ok: false, error });
      },
    );
  });
}

module.exports = { isAbortedNavigation, observeWindowLoad };
