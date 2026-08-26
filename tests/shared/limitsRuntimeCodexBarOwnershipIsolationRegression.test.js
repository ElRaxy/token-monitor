'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLimitsRuntime } = require('../../src/shared/limitsRuntime');

const NOW_MS = Date.parse('2026-08-25T08:00:00.000Z');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, message, maxTurns = 200) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message} after ${maxTurns} event-loop turns`);
}

function nativeKimiRow() {
  return {
    provider: 'kimi',
    accountKey: 'native-kimi',
    accountLabel: 'Native Kimi',
    source: 'api',
    status: 'ok',
    updatedAt: new Date(NOW_MS).toISOString(),
    windows: [{ kind: 'session', label: 'native-kimi', usedPercent: 10 }]
  };
}

function codexBarResult() {
  const producedAt = new Date(NOW_MS).toISOString();
  return {
    limits: {
      updatedAt: producedAt,
      refreshMs: 90_000,
      providers: [{
        provider: 'codex',
        source: 'oauth',
        status: 'ok',
        updatedAt: producedAt,
        windows: [{ kind: 'session', label: 'codexbar', usedPercent: 25 }],
        producer: 'codexbar',
        producerVersion: '0.55.0',
        producedAt,
        staleAfterMs: 180_000
      }]
    },
    meta: {
      schemaVersion: 1,
      producer: 'codexbar',
      producerVersion: '0.55.0',
      generatedAt: producedAt,
      staleAfterMs: 180_000
    },
    diagnostics: []
  };
}

test('CodexBar reconfigure does not supersede an unaffected native lane', async () => {
  const pendingKimi = deferred();
  const pendingDashboard = deferred();
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime({
    limitsEnabled: true,
    limitProviders: ['codex', 'kimi'],
    codexbarDashboardEnabled: true,
    codexbarDashboardUrl: 'http://127.0.0.1:8080',
    codexbarDashboardToken: 'fixture-token',
    codexbarDelegatedProviders: ['codex']
  }, {
    autoRetry: false,
    autoStart: false,
    cleanupGraceMs: 0,
    maxConcurrency: 2,
    now: () => NOW_MS,
    providerPhysicalBoundMs: () => 30_000,
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return pendingDashboard.promise;
    },
    probeProvider: async (provider) => {
      assert.equal(provider, 'kimi');
      nativeProbes += 1;
      if (nativeProbes === 1) return pendingKimi.promise;
      return [nativeKimiRow()];
    }
  });
  const kimiRefresh = runtime.refresh({ provider: 'kimi' }, 'manual');

  try {
    await waitFor(() => nativeProbes === 1, 'the native Kimi probe to start');
    runtime.reconfigure({
      codexbarDashboardUrl: 'http://localhost:9090'
    });
    pendingKimi.resolve([nativeKimiRow()]);
    pendingDashboard.resolve(codexBarResult());

    const result = await kimiRefresh;
    await waitFor(
      () => dashboardFetches === 1 && runtime.getDiagnostics().active === 0,
      'the automatic CodexBar refresh and Kimi lane to settle'
    );
    const kimiRow = runtime.getSnapshot().providers.find((row) => row.provider === 'kimi');

    assert.deepEqual({
      dashboardFetches,
      nativeProbes,
      superseded: result.superseded,
      kimiRow: kimiRow
        ? { accountLabel: kimiRow.accountLabel, status: kimiRow.status }
        : null
    }, {
      dashboardFetches: 1,
      nativeProbes: 1,
      superseded: false,
      kimiRow: { accountLabel: 'Native Kimi', status: 'ok' }
    });
  } finally {
    pendingKimi.resolve([nativeKimiRow()]);
    pendingDashboard.resolve(codexBarResult());
    runtime.stop();
    await Promise.allSettled([kimiRefresh]);
  }
});
