'use strict';

const NATIVE_TITLEBAR_HEIGHT = 30;

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
};
