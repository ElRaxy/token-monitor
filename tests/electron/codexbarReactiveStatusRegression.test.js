'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/electron/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} must have a complete body`);
}

test('CodexBar status has a dedicated redacted IPC read', () => {
  assert.match(
    preload,
    /getCodexBarDashboardStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]codexbar:status['"]\)/
  );
  assert.match(
    main,
    /ipcMain\.handle\(['"]codexbar:status['"],\s*\(\)\s*=>\s*codexbarDashboardStatus\(\)\)/
  );

  const status = functionBody(main, 'codexbarDashboardStatus');
  assert.doesNotMatch(status, /codexbarDashboardToken|bearer|secret/i);
});

test('CodexBar status refresh is one-shot, coalesced and publishes only status', () => {
  const refresh = functionBody(renderer, 'refreshCodexBarDashboardStatus');
  assert.match(refresh, /window\.tokenMonitor\.getCodexBarDashboardStatus\(\)/);
  assert.match(refresh, /codexbarDashboardStatus:\s*[a-zA-Z_$][\w$]*/);
  assert.match(refresh, /syncCodexBarDashboardStatus\(\)/);
  assert.doesNotMatch(refresh, /codexbarDashboardToken|bearer|secret/i);
  assert.doesNotMatch(refresh, /setInterval\s*\(|setTimeout\s*\(/);

  const coalesces = /if\s*\([^)]*(?:inFlight|Promise)[^)]*\)\s*return/i.test(refresh)
    && /finally\s*\{[\s\S]*?(?:inFlight|Promise)\s*=\s*null/i.test(refresh);
  const fencesRaces = /\+\+[^;]*(?:revision|generation)/i.test(refresh)
    && /(?:revision|generation)[\s\S]*?(?:!==|===)/i.test(refresh);
  assert.ok(coalesces || fencesRaces, 'refresh must coalesce overlapping reads or fence stale results');
});

test('opening Settings and live stats refresh CodexBar without polling', () => {
  const openSettings = functionBody(renderer, 'openSettingsPanel');
  assert.match(openSettings, /refreshCodexBarDashboardStatus\(\)/);

  const settingsButton = renderer.slice(
    renderer.indexOf("els.settingsButton.addEventListener('click'"),
    renderer.indexOf("els.saveSettingsButton.addEventListener('click'")
  );
  assert.match(
    settingsButton,
    /settingsOpen[\s\S]*?refreshCodexBarDashboardStatus\(\)/,
    'opening Settings from the toolbar must request a fresh status'
  );

  const statsPush = renderer.match(
    /window\.tokenMonitor\.onStatsPush\?\.\(\(payload\)\s*=>\s*\{[\s\S]*?\n\}\);/
  )?.[0] || '';
  assert.match(statsPush, /payload\.data\?\.stats[\s\S]*?refreshCodexBarDashboardStatus\(\)/);
  assert.match(
    statsPush,
    /settingsPanel[\s\S]*?classList\.contains\(['"]hidden['"]\)/,
    'stats pushes must read status only while Settings is visible'
  );
  assert.doesNotMatch(statsPush, /setInterval\s*\(|setTimeout\s*\(/);
});
