'use strict';

const NATIVE_TITLEBAR_HEIGHT = 30;
const DEFAULT_SYSTEM_WINDOW_CONTROLS = false;

function windowChromeState(settings = {}, options = {}) {
  return {
    systemWindowControls: settings.systemWindowControls === true,
    collapsedFloatingBubble: options.collapsedFloatingBubble === true,
    trayOnly: settings.trayMode === true,
  };
}

function windowChromeTransition(previousSettings = {}, nextSettings = {}, options = {}) {
  const trayModeChanged = nextSettings.trayMode !== previousSettings.trayMode;
  const systemWindowControlsChanged = nextSettings.systemWindowControls !== previousSettings.systemWindowControls;
  const nativeMaterialChanged = options.platform === 'win32'
    && options.previousNativeMaterial !== options.nextNativeMaterial;

  return {
    rebuild: trayModeChanged || systemWindowControlsChanged || nativeMaterialChanged,
    rebuildOptions: {
      ...(systemWindowControlsChanged ? { settingsSection: 'window' } : {}),
      ...(trayModeChanged && !nextSettings.trayMode ? { focus: true } : {}),
    },
  };
}

function windowChromeRequiresReplacement(platform, chrome = {}) {
  return platform === 'win32' || chrome.systemWindowControls === true;
}

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
  return { settle, dispose: cleanup };
}

function nativeWindowChromeOptions(platform = process.platform, options = {}) {
  if (options.systemWindowControls !== true || options.collapsed === true || options.trayOnly === true) {
    return { frame: false };
  }

  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#d9dee7',
      height: NATIVE_TITLEBAR_HEIGHT,
    },
  };
}

module.exports = {
  DEFAULT_SYSTEM_WINDOW_CONTROLS,
  NATIVE_TITLEBAR_HEIGHT,
  nativeWindowChromeOptions,
  observeMainFrameLoad,
  windowChromeRequiresReplacement,
  windowChromeState,
  windowChromeTransition,
};
