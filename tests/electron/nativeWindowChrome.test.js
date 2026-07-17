'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  NATIVE_TITLEBAR_HEIGHT,
  nativeWindowChromeOptions,
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

test('the widget persists opt-in chrome and rebuilds every immutable transition', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /systemWindowControls:\s*false/);
  assert.match(main, /merged\.systemWindowControls = parseBoolean\(merged\.systemWindowControls, false\)/);
  assert.match(main, /systemWindowControls: parseBoolean\(patch\.systemWindowControls \?\? settings\.systemWindowControls, false\)/);
  assert.match(main, /nativeWindowChromeOptions\(process\.platform, \{[\s\S]*?systemWindowControls: Boolean\(settings\?\.systemWindowControls\),[\s\S]*?collapsed: collapsedFloatingBubble,[\s\S]*?trayOnly: Boolean\(settings\?\.trayMode\)[\s\S]*?\}\)/);
  assert.match(main, /trayModeChanged \|\| systemWindowControlsChanged \|\| \(process\.platform === 'win32'/);
  assert.match(main, /rebuildWindow\(\{[\s\S]*?systemWindowControlsChanged \? \{ settingsSection: 'window' \}[\s\S]*?trayModeChanged && !settings\.trayMode \? \{ focus: true \}/);
  assert.match(main, /createWindow\(bounds, \{[\s\S]*?suppressInitialNumberAnimation: true,[\s\S]*?waitForContent: true,[\s\S]*?settingsSection: options\.settingsSection/);
  assert.match(main, /const shouldFocus = options\.focus === true \|\| wasFocused/);
  assert.match(main, /if \(previousTrayMode\) \{\s*rebuildWindow\(\{ focus: true \}\)/);
  assert.match(main, /if \(process\.platform === 'win32' \|\| mainWindowChrome\.systemWindowControls\)[\s\S]*?collapsedFloatingBubble:\s*true/);
  assert.match(main, /if \(mainWindowChrome\.collapsedFloatingBubble\)[\s\S]*?collapsedFloatingBubble:\s*false/);
});
