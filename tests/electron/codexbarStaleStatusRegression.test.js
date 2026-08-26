'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

const statusSource = functionSource(mainSource, 'codexbarDashboardStatus', 'settingsForRenderer');
const renderSource = functionSource(rendererSource, 'syncCodexBarDashboardStatus', 'syncCodexBarSettingsForm');
const labels = {
  'settings.codexbar.statusDisabled': 'CodexBar is disabled',
  'settings.codexbar.statusConfigured': 'CodexBar is configured',
  'settings.codexbar.statusConnecting': 'Connecting to CodexBar',
  'settings.codexbar.statusActive': 'Connected to CodexBar',
  'settings.codexbar.statusDegraded': 'CodexBar data is stale',
  'settings.codexbar.statusError': 'CodexBar is unavailable'
};

function projectStatus(row) {
  const context = {
    settings: {
      codexbarDashboardEnabled: true,
      codexbarDashboardToken: true,
      codexbarDelegatedProviders: ['codex']
    },
    deviceRuntimeHandle: {
      getDiagnostics: () => ({ limits: { providers: [] } }),
      getSnapshot: () => ({ limits: { providers: [row] } })
    },
    hasCodexBarDashboardCredential: () => true,
    result: null
  };
  vm.runInNewContext(`${statusSource}\nresult = codexbarDashboardStatus();`, context);
  return context.result;
}

function renderedStatus(status) {
  const output = { textContent: '', classList: { toggle() {} } };
  const context = {
    els: { codexbarDashboardStatus: output },
    state: { settings: { codexbarDashboardStatus: status } },
    CODEXBAR_STATUS_KEYS: {
      disabled: 'settings.codexbar.statusDisabled',
      configured: 'settings.codexbar.statusConfigured',
      connecting: 'settings.codexbar.statusConnecting',
      active: 'settings.codexbar.statusActive',
      degraded: 'settings.codexbar.statusDegraded',
      error: 'settings.codexbar.statusError'
    },
    CODEXBAR_DIAGNOSTIC_CODES: new Set(),
    t: (key) => labels[key] || key,
    formatTime: () => 'time',
    formatUpdatedAge: () => 'age'
  };
  vm.runInNewContext(`${renderSource}\nsyncCodexBarDashboardStatus();`, context);
  return output.textContent;
}

test('stale or unusable CodexBar rows never render as connected', () => {
  const now = Date.now();
  const cases = [
    {
      name: 'retained last-good row',
      expectedStatus: 'degraded',
      expectedLabel: labels['settings.codexbar.statusDegraded'],
      row: {
        provider: 'codex',
        producer: 'codexbar',
        status: 'unavailable',
        producedAt: new Date(now - 1_000).toISOString(),
        staleAfterMs: 60_000,
        windows: [{ kind: 'session', usedPercent: 25 }]
      }
    },
    {
      name: 'expired row without usable limits',
      expectedStatus: 'error',
      expectedLabel: labels['settings.codexbar.statusError'],
      row: {
        provider: 'codex',
        producer: 'codexbar',
        status: 'unavailable',
        producedAt: new Date(now - 120_000).toISOString(),
        staleAfterMs: 60_000,
        windows: []
      }
    }
  ];

  const actual = cases.map(({ name, expectedStatus, expectedLabel, row }) => {
    const projection = projectStatus(row);
    const rendered = renderedStatus(projection);
    return {
      name,
      projectedStatus: projection.status,
      expectedStatus,
      showsConnected: rendered.includes(labels['settings.codexbar.statusActive']),
      showsExpectedStatus: rendered.includes(expectedLabel)
    };
  });

  assert.deepEqual(actual, cases.map(({ name, expectedStatus }) => ({
    name,
    projectedStatus: expectedStatus,
    expectedStatus,
    showsConnected: false,
    showsExpectedStatus: true
  })));
});
