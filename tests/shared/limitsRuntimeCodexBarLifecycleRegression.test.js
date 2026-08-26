'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLimitsRuntime } = require('../../src/shared/limitsRuntime');

const NOW_MS = Date.parse('2026-08-25T08:00:00.000Z');
const DASHBOARD_TOKEN = 'fixture-token';

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

function runtimeOptions(overrides = {}) {
  return {
    limitsEnabled: true,
    limitProviders: ['codex'],
    codexbarDashboardEnabled: true,
    codexbarDashboardUrl: 'http://127.0.0.1:8080',
    codexbarDashboardToken: DASHBOARD_TOKEN,
    codexbarDelegatedProviders: 'codex',
    ...overrides
  };
}

function runtimeDeps(overrides = {}) {
  return {
    autoRetry: false,
    autoStart: false,
    cleanupGraceMs: 0,
    maxConcurrency: 1,
    now: () => NOW_MS,
    providerPhysicalBoundMs: () => 30_000,
    ...overrides
  };
}

function dashboardResult(version) {
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
        windows: [{ kind: 'session', label: version, usedPercent: 25 }],
        producer: 'codexbar',
        producerVersion: version,
        producedAt,
        staleAfterMs: 180_000
      }]
    },
    meta: {
      schemaVersion: 1,
      producer: 'codexbar',
      producerVersion: version,
      generatedAt: producedAt,
      staleAfterMs: 180_000
    },
    diagnostics: []
  };
}

function nativeKimiRow() {
  return {
    provider: 'kimi',
    accountKey: 'native-kimi',
    accountLabel: 'Native Kimi',
    source: 'api',
    status: 'ok',
    updatedAt: new Date(NOW_MS).toISOString(),
    windows: [{ kind: 'session', label: 'native', usedPercent: 10 }]
  };
}

test('CodexBar sanitizes config-resolution failures before publishing them', async () => {
  const unsafeMessage = `configuration rejected ${DASHBOARD_TOKEN}`;
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    resolveConfigSnapshot: async () => {
      throw new Error(unsafeMessage);
    },
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult('unexpected-dashboard');
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [];
    }
  }));

  try {
    const result = await runtime.refresh({ provider: 'codex' }, 'manual');
    const row = runtime.getSnapshot().providers[0];
    const diagnostics = runtime.getDiagnostics();

    assert.deepEqual({ dashboardFetches, nativeProbes }, { dashboardFetches: 0, nativeProbes: 0 });
    assert.equal(Object.getPrototypeOf(result.error), Object.prototype);
    assert.deepEqual(result.error, { code: 'unavailable', status: 'unavailable' });
    assert.equal(Object.hasOwn(result.error, 'message'), false);
    assert.deepEqual(
      { provider: row.provider, status: row.status, producer: row.producer },
      { provider: 'codex', status: 'unavailable', producer: 'codexbar' }
    );
    assert.equal(diagnostics.providers[0].lastFailureCode, 'unavailable');

    const publicSurface = JSON.stringify({
      diagnostics,
      error: result.error,
      errorMessage: result.error?.message,
      row
    });
    assert.equal(publicSurface.includes(DASHBOARD_TOKEN), false);
    assert.equal(publicSurface.includes(unsafeMessage), false);
  } finally {
    runtime.stop();
  }
});

test('superseding the only dashboard consumer aborts its fetch while a native lane stays active', async () => {
  const oldDashboard = deferred();
  const latestDashboard = deferred();
  const nativeProbe = deferred();
  const dashboardRequests = [];
  let nativeCompleted = false;
  let nativeProbes = 0;
  const pendingRefreshes = [];
  const runtime = createLimitsRuntime(runtimeOptions({
    limitProviders: ['codex', 'kimi']
  }), runtimeDeps({
    maxConcurrency: 2,
    fetchCodexBarDashboard: (options) => {
      dashboardRequests.push(options);
      return dashboardRequests.length === 1 ? oldDashboard.promise : latestDashboard.promise;
    },
    probeProvider: async (provider) => {
      assert.equal(provider, 'kimi');
      nativeProbes += 1;
      const rows = await nativeProbe.promise;
      nativeCompleted = true;
      return rows;
    }
  }));

  let observed;
  try {
    const fullRefresh = runtime.refresh({}, 'manual');
    pendingRefreshes.push(fullRefresh);
    await waitFor(
      () => dashboardRequests.length === 1 && nativeProbes === 1,
      'the old dashboard fetch and native Kimi probe to start'
    );

    const latestRefresh = runtime.refresh({ provider: 'codex' }, 'manual');
    pendingRefreshes.push(latestRefresh);
    const oldSignalAbortedImmediately = dashboardRequests[0].signal.aborted;
    await waitFor(() => dashboardRequests.length === 2, 'the replacement dashboard fetch to start');

    observed = {
      oldSignalAbortedImmediately,
      replacementStartedWhileNativePending: !nativeCompleted,
      nativeProbes,
      active: runtime.getDiagnostics().active
    };

    latestDashboard.resolve(dashboardResult('latest'));
    await latestRefresh;
    oldDashboard.resolve(dashboardResult('old'));
    nativeProbe.resolve([nativeKimiRow()]);
    await fullRefresh;
  } finally {
    runtime.stop();
    oldDashboard.resolve(dashboardResult('old-cleanup'));
    latestDashboard.resolve(dashboardResult('latest-cleanup'));
    nativeProbe.resolve([nativeKimiRow()]);
    await Promise.allSettled(pendingRefreshes);
  }

  assert.deepEqual(observed, {
    oldSignalAbortedImmediately: true,
    replacementStartedWhileNativePending: true,
    nativeProbes: 1,
    active: 2
  });
});
