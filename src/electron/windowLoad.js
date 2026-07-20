'use strict';

function observeMainFrameLoad(webContents, onSettled) {
  let settled = false;
  const cleanup = () => {
    webContents.removeListener('did-finish-load', onFinished);
    webContents.removeListener('did-fail-load', onFailed);
  };
  const settle = (result) => {
    if (settled) return false;
    settled = true;
    cleanup();
    onSettled(result);
    return true;
  };
  const onFinished = () => settle({ ok: true });
  const onFailed = (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    settle({ ok: false, errorCode, errorDescription });
  };

  webContents.once('did-finish-load', onFinished);
  webContents.on('did-fail-load', onFailed);
}

module.exports = { observeMainFrameLoad };
