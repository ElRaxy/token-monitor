'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const SHARED_PROVIDER_IDS = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'cursor',
  'antigravity',
  'kimi',
  'grok',
  'copilot',
  'commandcode',
  'mimo',
  'zai',
  'kiro',
  'qoder',
  'deepseek',
  'openrouter',
  'minimax',
  'volcengine',
  'ollama'
]);
const TOKEN_MONITOR_ONLY_PROVIDER_IDS = Object.freeze([
  'zaiteam',
  'workbuddy',
  'trae',
  'thirdparty'
]);

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected CodexBar configuration to reject the provider');
}

function assertSettingsIpcTransport() {
  const preload = fs.readFileSync(path.join(ROOT, 'src/electron/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
  const rendererSettings = functionSource(main, 'settingsForRenderer');
  const updateHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('appearance:preview'")
  );
  const init = functionSource(renderer, 'init');

  assert.match(preload, /getSettings:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]settings:get['"]\)/);
  assert.doesNotMatch(preload, /codexbarDashboardProviderIds/);
  assert.match(rendererSettings, /codexbarDashboardProviderIds:\s*CODEXBAR_DASHBOARD_PROVIDER_IDS/);
  assert.match(updateHandler, /delete normalizedPatch\.codexbarDashboardProviderIds/);
  assert.match(init, /state\.settings\s*=\s*await window\.tokenMonitor\.getSettings\(\);[\s\S]*hydrateCodexBarDashboardProviderIds\(state\.settings\)/);
}

function functionSource(source, name) {
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

function renderedProviderIds(providerIds) {
  const source = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
  const makeNode = (tagName) => ({
    tagName,
    children: [],
    dataset: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes.flatMap((node) => node.children || [node]);
    }
  });
  const container = makeNode('div');
  const context = vm.createContext({
    codexbarDashboardProviderIds: new Set(providerIds),
    document: {
      createDocumentFragment: () => makeNode('fragment'),
      createElement: makeNode
    },
    els: { codexbarDelegatedProviderCheckboxes: container },
    LIMIT_PROVIDERS: [
      ...SHARED_PROVIDER_IDS,
      ...TOKEN_MONITOR_ONLY_PROVIDER_IDS
    ].map((id) => ({ id, label: id })),
    state: { settings: { codexbarDelegatedProviders: providerIds.join(',') } }
  });
  vm.runInContext(`${functionSource(source, 'renderCodexBarDelegatedProviders')}; renderCodexBarDelegatedProviders();`, context);
  return container.children.map((label) => label.children[0]?.dataset?.provider).filter(Boolean);
}

function inlineCodeIds(line) {
  return [...line.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]);
}

test('dashboard-v1 v0.55.0 has one exported shared provider allowlist', () => {
  const {
    CODEXBAR_DASHBOARD_PROVIDER_IDS,
    normalizeCodexBarConfig
  } = require('../../src/shared/codexbarConfig');

  assert.deepEqual(CODEXBAR_DASHBOARD_PROVIDER_IDS, SHARED_PROVIDER_IDS);
  assert.equal(Object.isFrozen(CODEXBAR_DASHBOARD_PROVIDER_IDS), true);
  assert.deepEqual(normalizeCodexBarConfig({
    codexbarDelegatedProviders: SHARED_PROVIDER_IDS
  }).codexbarDelegatedProviders, SHARED_PROVIDER_IDS);

  for (const provider of TOKEN_MONITOR_ONLY_PROVIDER_IDS) {
    const error = captureError(() => normalizeCodexBarConfig({
      codexbarDelegatedProviders: [provider]
    }));
    assert.equal(error?.name, 'CodexBarConfigError');
    assert.equal(error?.code, 'unknown-provider');
  }
});

test('desktop selector consumes the shared allowlist projected through settings IPC', () => {
  const { CODEXBAR_DASHBOARD_PROVIDER_IDS } = require('../../src/shared/codexbarConfig');

  assert.deepEqual(CODEXBAR_DASHBOARD_PROVIDER_IDS, SHARED_PROVIDER_IDS);
  assertSettingsIpcTransport();
  assert.deepEqual(renderedProviderIds(CODEXBAR_DASHBOARD_PROVIDER_IDS), SHARED_PROVIDER_IDS);
});

test('CodexBar documentation only advertises dashboard-v1 providers as delegable', () => {
  const configuration = fs.readFileSync(path.join(ROOT, 'docs/configuration.md'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8');
  const delegatedLine = configuration.split('\n').find((line) => (
    line.startsWith('Canonical delegated provider IDs are ')
  ));
  const provenanceProviderLine = api.split('\n').find((line) => (
    line.startsWith('CodexBar-delegable provider IDs are ')
  ));

  assert.ok(delegatedLine, 'configuration must enumerate canonical delegated providers');
  assert.ok(provenanceProviderLine, 'API provenance must enumerate dashboard provider IDs');
  assert.deepEqual(inlineCodeIds(delegatedLine.split('. The incoming')[0]), SHARED_PROVIDER_IDS);
  const provenanceProviderIds = inlineCodeIds(provenanceProviderLine);
  for (const provider of TOKEN_MONITOR_ONLY_PROVIDER_IDS) {
    assert.equal(provenanceProviderIds.includes(provider), false, `${provider} is not dashboard-delegable`);
  }
});
