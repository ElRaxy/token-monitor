'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIN_CONTROL_CONTRAST,
  NATIVE_TITLEBAR_HEIGHT,
  applyNativeWindowTitleBarOverlay,
  contrastRatio,
  nativeWindowControlSymbolColor,
  nativeWindowChromeOptions,
  windowChromeTransition,
} = require('../../src/electron/nativeWindowChrome');
const { THEME_PRESETS } = require('../../src/electron/renderer/themePresets');

test('macOS keeps inset native traffic lights without a visible title bar', () => {
  assert.deepEqual(nativeWindowChromeOptions('darwin', { systemWindowControls: true }), {
    titleBarStyle: 'hiddenInset',
  });
});

test('Windows and Linux use the native window-controls overlay', () => {
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(nativeWindowChromeOptions(platform, { systemWindowControls: true }), {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#eef5fb',
        height: NATIVE_TITLEBAR_HEIGHT,
      },
    });
  }
  assert.equal(NATIVE_TITLEBAR_HEIGHT, 30);
});

test('native control symbols follow the theme and maintain non-text contrast', () => {
  const porcelain = THEME_PRESETS.find((preset) => preset.id === 'porcelain').colors;
  assert.equal(nativeWindowControlSymbolColor(porcelain), '#1c1f26');
  assert.ok(contrastRatio(nativeWindowControlSymbolColor(porcelain), porcelain.bg) >= MIN_CONTROL_CONTRAST);

  const lowContrastTheme = { bg: '#f6f7f9', text: '#d9dee7' };
  const fallback = nativeWindowControlSymbolColor(lowContrastTheme);
  assert.equal(fallback, '#000000');
  assert.ok(contrastRatio(fallback, lowContrastTheme.bg) >= MIN_CONTROL_CONTRAST);
});

test('live title-bar overlay updates only supported native-control windows', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    setTitleBarOverlay: (options) => calls.push(options),
  };
  const porcelain = THEME_PRESETS.find((preset) => preset.id === 'porcelain').colors;

  assert.equal(applyNativeWindowTitleBarOverlay(win, 'win32', {
    systemWindowControls: true,
    themeColors: porcelain,
  }), true);
  assert.equal(calls[0].symbolColor, '#1c1f26');

  assert.equal(applyNativeWindowTitleBarOverlay(win, 'darwin', { systemWindowControls: true }), false);
  assert.equal(applyNativeWindowTitleBarOverlay(win, 'linux', { systemWindowControls: true, trayOnly: true }), false);
  assert.equal(applyNativeWindowTitleBarOverlay(win, 'linux', { systemWindowControls: true, collapsed: true }), false);
  assert.equal(applyNativeWindowTitleBarOverlay(win, 'linux', { systemWindowControls: false }), false);
  assert.equal(calls.length, 1);
});

test('custom controls, collapsed bubbles, and tray-only popovers stay frameless', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.deepEqual(nativeWindowChromeOptions(platform), { frame: false });
    assert.deepEqual(nativeWindowChromeOptions(platform, { collapsed: true }), { frame: false });
    assert.deepEqual(nativeWindowChromeOptions(platform, { trayOnly: true }), { frame: false });
    assert.deepEqual(nativeWindowChromeOptions(platform, { systemWindowControls: true, collapsed: true }), { frame: false });
    assert.deepEqual(nativeWindowChromeOptions(platform, { systemWindowControls: true, trayOnly: true }), { frame: false });
  }
});

test('immutable chrome transitions produce the correct rebuild plan', () => {
  assert.deepEqual(
    windowChromeTransition(
      { trayMode: false, systemWindowControls: false },
      { trayMode: false, systemWindowControls: true },
      { platform: 'darwin', previousNativeMaterial: false, nextNativeMaterial: false },
    ),
    { rebuild: true, rebuildOptions: { settingsSection: 'window' } },
  );
  assert.deepEqual(
    windowChromeTransition(
      { trayMode: true, systemWindowControls: true },
      { trayMode: false, systemWindowControls: true },
      { platform: 'linux', previousNativeMaterial: false, nextNativeMaterial: false },
    ),
    { rebuild: true, rebuildOptions: { focus: true } },
  );
  assert.equal(
    windowChromeTransition(
      { trayMode: false, systemWindowControls: false },
      { trayMode: false, systemWindowControls: false },
      { platform: 'win32', previousNativeMaterial: false, nextNativeMaterial: true },
    ).rebuild,
    true,
  );
  assert.equal(
    windowChromeTransition(
      { trayMode: false, systemWindowControls: false },
      { trayMode: false, systemWindowControls: false },
      { platform: 'darwin', previousNativeMaterial: false, nextNativeMaterial: true },
    ).rebuild,
    false,
  );
});
