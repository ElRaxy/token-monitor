'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/electron/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/index.html'), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const parametersStart = source.indexOf('(', start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') parameterDepth -= 1;
    if (parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} must have complete parameters`);
  const open = source.indexOf('{', parametersEnd);
  assert.notEqual(open, -1, `${name} must have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} must have a complete body`);
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function htmlTagWithId(id) {
  return html.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>`, 'i'))?.[0] || '';
}

function codexbarSummaryReconcileHarness(startImplementations) {
  const sources = [
    functionBody(main, 'codexbarSummaryBridgeErrorCode'),
    functionBody(main, 'codexbarSummaryStatus'),
    functionBody(main, 'reconcileCodexBarSummaryBridge')
  ].join('\n');
  const createHarness = new Function('startImplementations', `
    let settings = { codexbarSummaryEnabled: true, codexbarSummaryToken: 'test-token' };
    let latestStats = null;
    let codexbarSummaryBridge = null;
    let codexbarSummaryReconcileGeneration = 0;
    let codexbarSummaryReconcilePromise = Promise.resolve();
    let codexbarSummaryBridgeState = {
      enabled: false,
      configured: false,
      status: 'disabled',
      errorCode: null
    };
    const CODEXBAR_SUMMARY_HOST = '127.0.0.1';
    const CODEXBAR_SUMMARY_PORT = 17322;
    const CODEXBAR_SUMMARY_ENDPOINT = 'http://127.0.0.1:17322/api/integrations/codexbar/v1/summary';
    const app = { getVersion: () => '0.48.0' };
    const console = { warn: () => {} };
    const published = [];
    let startIndex = 0;
    const createCodexBarSummaryServer = () => ({
      start: () => startImplementations[startIndex++](),
      stop: async () => {}
    });
    const stopCodexBarSummaryBridge = async (target = codexbarSummaryBridge) => {
      if (!target) return;
      if (target === codexbarSummaryBridge) codexbarSummaryBridge = null;
      try { await target.stop(); } catch (_) {}
    };
    const pushSettingsToRenderer = () => { published.push(codexbarSummaryStatus()); };
    ${sources}
    return {
      published,
      reconcile: reconcileCodexBarSummaryBridge,
      status: codexbarSummaryStatus,
      setSettings(next) { settings = { ...settings, ...next }; }
    };
  `);
  return createHarness(startImplementations);
}

test('R19 enlaza el bridge opt-in a arranque, settings, latestStats y stopAll', () => {
  const defaults = functionBody(main, 'defaultSettings');
  const reconcile = functionBody(main, 'reconcileCodexBarSummaryBridge');
  const settingsUpdate = between(
    main,
    "ipcMain.handle('settings:update'",
    "ipcMain.handle('appearance:preview'"
  );
  const quit = functionBody(main, 'stopAll');

  assert.match(defaults, /codexbarSummaryEnabled:\s*false/);
  assert.match(reconcile, /settings\?*\.codexbarSummaryEnabled|settings\.codexbarSummaryEnabled/);
  assert.match(reconcile, /127\.0\.0\.1|CODEXBAR_SUMMARY_HOST/);
  assert.match(reconcile, /17322|CODEXBAR_SUMMARY_PORT/);
  assert.match(reconcile, /getStats:\s*\(\)\s*=>\s*latestStats|latestStats:\s*\(\)\s*=>\s*latestStats/);
  assert.match(reconcile, /\.start\s*\(|startCodexBarSummaryBridge\s*\(/);
  assert.match(reconcile, /\.stop\s*\(|stopCodexBarSummaryBridge\s*\(/);
  assert.match(settingsUpdate, /reconcileCodexBarSummaryBridge\s*\(/);
  assert.match(quit, /codexbarSummaryBridge[^;\n]*(?:stop|close)\s*\(|stopCodexBarSummaryBridge\s*\(/);

  const calls = [...main.matchAll(/reconcileCodexBarSummaryBridge\s*\(/g)].length;
  assert.ok(calls >= 3, 'bridge reconciliation must run at definition, app startup, and settings save');

  const sendPush = functionBody(main, 'sendPush');
  assert.match(sendPush, /latestStats\s*=\s*payload\.data\.stats/);
  assert.doesNotMatch(reconcile, /fetchStats|force:\s*true|UsageRuntime|LimitsRuntime|collector|probe/i);
});

test('R19 expone status, copia y regeneracion por IPC sin devolver el bearer', () => {
  for (const [method, channel] of [
    ['getCodexBarSummaryStatus', 'codexbarSummary:status'],
    ['copyCodexBarSummaryToken', 'codexbarSummary:copyToken'],
    ['regenerateCodexBarSummaryToken', 'codexbarSummary:regenerateToken']
  ]) {
    assert.match(
      preload,
      new RegExp(`${method}:\\s*\\(\\)\\s*=>\\s*ipcRenderer\\.invoke\\(['"]${channel}['"]\\)`),
      `${method} must be an argument-free IPC capability`
    );
    assert.match(main, new RegExp(`ipcMain\\.handle\\(['"]${channel}['"]`));
  }

  assert.match(
    main,
    /ipcMain\.handle\(['"]codexbarSummary:copyToken['"],\s*\(\)\s*=>\s*copyCodexBarSummaryToken\(\)\)/
  );
  assert.match(
    main,
    /ipcMain\.handle\(['"]codexbarSummary:regenerateToken['"],\s*\(\)\s*=>\s*regenerateCodexBarSummaryToken\(\)\)/
  );

  const status = functionBody(main, 'codexbarSummaryStatus');
  const copy = functionBody(main, 'copyCodexBarSummaryToken');
  const regenerate = functionBody(main, 'regenerateCodexBarSummaryToken');
  assert.doesNotMatch(status, /codexbarSummaryToken|bearer|credential|secret/i);
  assert.match(copy, /clipboard\.writeText\s*\(/);
  assert.doesNotMatch(copy, /return\s+(?:token|summaryToken|codexbarSummaryToken)\b/i);
  assert.match(regenerate, /random|generate|rotate|regenerat/i);
  assert.match(regenerate, /saveSettings|credential|persist/i);
  assert.match(regenerate, /reconcileCodexBarSummaryBridge\s*\(/);
});

test('R20 mantiene el token fuera de settingsForRenderer y de toda la UI web', () => {
  const settingsForRenderer = functionBody(main, 'settingsForRenderer');
  assert.match(settingsForRenderer, /delete rendererSettings\.codexbarSummaryToken/);
  assert.match(settingsForRenderer, /codexbarSummaryTokenConfigured:\s*Boolean\s*\(/);
  assert.doesNotMatch(
    settingsForRenderer,
    /codexbarSummaryToken:\s*(?:settings|rendererSettings|credentials|ensureCredentialStore)/,
    'renderer settings must expose only tokenConfigured, never the token'
  );
  assert.doesNotMatch(renderer, /state\.settings\?*\.codexbarSummaryToken\b/);
  assert.doesNotMatch(renderer, /codexbarSummaryToken\s*:/);
  assert.doesNotMatch(html, /<input[^>]+id=["']codexbarSummaryToken/i);
  assert.doesNotMatch(preload, /copyCodexBarSummaryToken:\s*\([^)]/);
  assert.doesNotMatch(preload, /regenerateCodexBarSummaryToken:\s*\([^)]/);
});

test('R20 presenta controles minimos y redacted para la direccion Token Monitor a CodexBar', () => {
  for (const id of [
    'codexbarSummarySettingsGroup',
    'codexbarSummaryStatus',
    'codexbarSummaryEndpoint',
    'codexbarSummaryEnabledInput',
    'codexbarSummaryCopyTokenButton',
    'codexbarSummaryRegenerateTokenButton'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} must exist in Settings`);
    assert.match(renderer, new RegExp(`${id}:\\s*document\\.getElementById\\(['"]${id}['"]\\)`));
  }

  assert.match(htmlTagWithId('codexbarSummaryEnabledInput'), /type=["']checkbox["']/i);
  assert.match(htmlTagWithId('codexbarSummaryEndpoint'), /(?:code|output|span|p)\b/i);
  assert.match(renderer, /codexbarSummaryCopyTokenButton[^\n]*addEventListener\(['"]click["'][\s\S]*?copyCodexBarSummaryToken\(\)/);
  assert.match(renderer, /codexbarSummaryRegenerateTokenButton[^\n]*addEventListener\(['"]click["'][\s\S]*?regenerateCodexBarSummaryToken\(\)/);
  assert.match(renderer, /getCodexBarSummaryStatus\(\)/);
  assert.match(renderer, /codexbarSummaryTokenConfigured/);
  assert.match(renderer, /codexbarSummaryEndpoint[^\n]*(?:127\.0\.0\.1|endpoint|baseUrl|url)/i);
});

test('R19 publica active o EADDRINUSE solo cuando termina la generacion vigente', async () => {
  let releaseFirstStart;
  const firstStart = new Promise((resolve) => { releaseFirstStart = resolve; });
  const delayed = codexbarSummaryReconcileHarness([
    () => firstStart,
    async () => {}
  ]);

  const superseded = delayed.reconcile();
  await Promise.resolve();
  delayed.setSettings({ codexbarSummaryToken: 'new-test-token' });
  const current = delayed.reconcile();
  releaseFirstStart();
  await Promise.all([superseded, current]);

  assert.deepEqual(delayed.published, [{
    enabled: true,
    configured: true,
    status: 'active',
    endpoint: 'http://127.0.0.1:17322/api/integrations/codexbar/v1/summary',
    errorCode: null
  }], 'a delayed superseded startup must not publish over the current generation');

  const occupied = codexbarSummaryReconcileHarness([
    async () => { throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); }
  ]);
  await occupied.reconcile();
  assert.equal(occupied.published.at(-1)?.status, 'error');
  assert.equal(occupied.published.at(-1)?.errorCode, 'port-in-use');
});

test('R19 no permite que una lectura starting anterior pise un settings:push terminal', () => {
  const refresh = functionBody(renderer, 'refreshCodexBarSummaryStatus');
  assert.match(refresh, /settingsPushRevision/);
  assert.match(
    refresh,
    /state\.settingsPushRevision\s*!==[^\n]+settingsPushRevision|settingsPushRevision[^\n]+!==\s*state\.settingsPushRevision/,
    'the renderer must reject a status response older than the latest settings push'
  );
});
