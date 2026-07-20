'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  DEFAULT_SYSTEM_WINDOW_CONTROLS,
  NATIVE_TITLEBAR_HEIGHT,
  nativeWindowChromeOptions,
  observeMainFrameLoad,
  windowChromeRequiresReplacement,
  windowChromeState,
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

test('window chrome state defaults to custom controls and tracks immutable modes', () => {
  assert.equal(DEFAULT_SYSTEM_WINDOW_CONTROLS, false);
  assert.deepEqual(windowChromeState(), {
    systemWindowControls: false,
    collapsedFloatingBubble: false,
    trayOnly: false,
  });
  assert.deepEqual(
    windowChromeState(
      { systemWindowControls: true, trayMode: true },
      { collapsedFloatingBubble: true },
    ),
    { systemWindowControls: true, collapsedFloatingBubble: true, trayOnly: true },
  );
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

test('floating bubbles replace native-control windows and all Windows windows', () => {
  assert.equal(windowChromeRequiresReplacement('darwin', { systemWindowControls: false }), false);
  assert.equal(windowChromeRequiresReplacement('darwin', { systemWindowControls: true }), true);
  assert.equal(windowChromeRequiresReplacement('win32', { systemWindowControls: false }), true);
});

test('main-frame load failures settle hidden window replacements exactly once', () => {
  const webContents = new EventEmitter();
  const results = [];
  observeMainFrameLoad(webContents, (result) => results.push(result));

  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', false);
  webContents.emit('did-fail-load', {}, -3, 'ABORTED', '', true);
  assert.deepEqual(results, []);

  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', true);
  webContents.emit('did-finish-load');
  assert.deepEqual(results, [{ ok: false, errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED' }]);
  assert.equal(webContents.listenerCount('did-fail-load'), 0);
  assert.equal(webContents.listenerCount('did-finish-load'), 0);
});

test('successful main-frame loads settle hidden window replacements exactly once', () => {
  const webContents = new EventEmitter();
  const results = [];
  observeMainFrameLoad(webContents, (result) => results.push(result));

  webContents.emit('did-finish-load');
  webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', '', true);
  assert.deepEqual(results, [{ ok: true }]);
});
