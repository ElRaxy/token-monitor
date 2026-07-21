'use strict';

const { mergeThemeColors } = require('./renderer/themePresets');

const NATIVE_TITLEBAR_HEIGHT = 30;
const MIN_CONTROL_CONTRAST = 3;

function relativeLuminance(hex) {
  const value = String(hex || '').replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const component = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return component <= 0.04045
      ? component / 12.92
      : ((component + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function nativeWindowControlSymbolColor(themeColors = {}) {
  const theme = mergeThemeColors(themeColors);
  if (contrastRatio(theme.text, theme.bg) >= MIN_CONTROL_CONTRAST) return theme.text;
  return contrastRatio('#000000', theme.bg) >= contrastRatio('#ffffff', theme.bg)
    ? '#000000'
    : '#ffffff';
}

function nativeWindowTitleBarOverlay(themeColors = {}) {
  return {
    color: '#00000000',
    symbolColor: nativeWindowControlSymbolColor(themeColors),
    height: NATIVE_TITLEBAR_HEIGHT,
  };
}

function applyNativeWindowTitleBarOverlay(win, platform = process.platform, options = {}) {
  if (platform !== 'win32' && platform !== 'linux') return false;
  if (options.systemWindowControls !== true || options.collapsed === true || options.trayOnly === true) return false;
  if (!win || win.isDestroyed?.() || typeof win.setTitleBarOverlay !== 'function') return false;
  try {
    win.setTitleBarOverlay(nativeWindowTitleBarOverlay(options.themeColors));
    return true;
  } catch (_) {
    return false;
  }
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

function nativeWindowChromeOptions(platform = process.platform, options = {}) {
  if (options.systemWindowControls !== true || options.collapsed === true || options.trayOnly === true) {
    return { frame: false };
  }

  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: nativeWindowTitleBarOverlay(options.themeColors),
  };
}

module.exports = {
  MIN_CONTROL_CONTRAST,
  NATIVE_TITLEBAR_HEIGHT,
  applyNativeWindowTitleBarOverlay,
  contrastRatio,
  nativeWindowControlSymbolColor,
  nativeWindowChromeOptions,
  nativeWindowTitleBarOverlay,
  windowChromeTransition,
};
