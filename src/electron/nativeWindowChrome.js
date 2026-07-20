'use strict';

const NATIVE_TITLEBAR_HEIGHT = 30;

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
  NATIVE_TITLEBAR_HEIGHT,
  nativeWindowChromeOptions,
  windowChromeTransition,
};
