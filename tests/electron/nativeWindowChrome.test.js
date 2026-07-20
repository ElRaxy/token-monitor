'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NATIVE_TITLEBAR_HEIGHT,
  nativeWindowChromeOptions,
  windowChromeTransition,
} = require('../../src/electron/nativeWindowChrome');

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
        symbolColor: '#d9dee7',
        height: NATIVE_TITLEBAR_HEIGHT,
      },
    });
  }
  assert.equal(NATIVE_TITLEBAR_HEIGHT, 30);
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
