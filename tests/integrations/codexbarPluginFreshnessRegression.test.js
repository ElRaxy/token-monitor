'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '../../integrations/codexbar/token-monitor.js');

function loadPlugin() {
  let definition;
  vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8'), {
    defineProvider(value) { definition = value; }
  });
  return definition;
}

function contextFor(payload) {
  return {
    settings: { get: () => 'http://127.0.0.1:17322' },
    http: { getJSON: async () => ({ status: 200, headers: {}, json: payload }) },
    fail: {
      parseFailure: (message) => Object.assign(new Error(message), { code: 'parseFailure' }),
      providerUnavailable: (message) => new Error(message),
      authenticationExpired: (message) => new Error(message),
      permissionDenied: (message) => new Error(message),
      apiFailure: (message) => new Error(message)
    },
    format: {
      number: (value) => String(value),
      usd: (value) => `$${value}`
    }
  };
}

test('R21 accepts unknown producer version and source timestamp instead of inventing facts', async () => {
  const plugin = loadPlugin();
  const snapshot = await plugin.fetchUsage(contextFor({
    schemaVersion: 1,
    generatedAt: '2026-08-26T08:30:00.000Z',
    producer: { id: 'token-monitor', version: null },
    freshness: {
      observedAt: null,
      ageSeconds: null,
      sourceCount: 0,
      staleSourceCount: 0
    },
    periods: {
      today: { totalTokens: 0, costUsd: null },
      month: { totalTokens: 0, costUsd: null }
    }
  }));

  const updated = snapshot.details[0].rows[2];
  assert.equal(updated.label, 'Actualizado');
  assert.match(updated.value, /sin (?:marca temporal|datos temporales|observaci[oó]n)/i);
  assert.doesNotMatch(JSON.stringify(updated), /null|undefined|NaN/i);
});

test('R21 exposes stale source count when Token Monitor reports it', async () => {
  const plugin = loadPlugin();
  const snapshot = await plugin.fetchUsage(contextFor({
    schemaVersion: 1,
    generatedAt: '2026-08-26T08:30:00.000Z',
    producer: { id: 'token-monitor', version: '0.48.0' },
    freshness: {
      observedAt: '2026-08-26T08:29:52.000Z',
      ageSeconds: 8,
      sourceCount: 2,
      staleSourceCount: 1
    },
    periods: {
      today: { totalTokens: 10, costUsd: null },
      month: { totalTokens: 20, costUsd: null }
    }
  }));

  assert.match(snapshot.details[0].rows[2].secondaryValue, /1\s+stale/i);
});
