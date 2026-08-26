'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLimitsRuntime } = require('../../src/shared/limitsRuntime');

const NOW_MS = Date.parse('2026-08-25T08:00:00.000Z');
const DASHBOARD_TOKEN = 'ownership-fixture-token';

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

function dashboardResult(version = 'ownership-contract') {
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

function nativeRow(label) {
  return {
    provider: 'codex',
    accountKey: 'native-codex',
    accountLabel: label,
    source: 'api',
    status: 'ok',
    updatedAt: new Date(NOW_MS).toISOString(),
    windows: [{ kind: 'session', label, usedPercent: 10 }]
  };
}

test('delegated owner inherits omitted ownership keys from a partial config snapshot', async () => {
  let dashboardFetches = 0;
  let nativeProbes = 0;
  let dashboardOptions;
  const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    resolveConfigSnapshot: async () => ({ limitsRefreshMode: 'fixed' }),
    fetchCodexBarDashboard: async (options) => {
      dashboardFetches += 1;
      dashboardOptions = options;
      return dashboardResult();
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [nativeRow('unexpected-native')];
    }
  }));

  try {
    await runtime.refresh({ provider: 'codex', accountKey: 'ignored-account' }, 'manual');

    assert.deepEqual({ dashboardFetches, nativeProbes }, { dashboardFetches: 1, nativeProbes: 0 });
    assert.equal(dashboardOptions.baseUrl, 'http://127.0.0.1:8080');
    assert.equal(dashboardOptions.token, DASHBOARD_TOKEN);
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { accountKey: rows[0].accountKey, producer: rows[0].producer },
      { accountKey: '', producer: 'codexbar' }
    );
  } finally {
    runtime.stop();
  }
});

test('native owner rejects an explicit resolver delegation without probing', async () => {
  const resolverSecret = 'resolver-delegation-secret';
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions({
    codexbarDashboardEnabled: ' off ',
    codexbarDashboardToken: resolverSecret
  }), runtimeDeps({
    resolveConfigSnapshot: async () => ({
      codexbarDashboardEnabled: ' YES ',
      codexbarDashboardUrl: ' http://127.0.0.1:8080 ',
      codexbarDashboardToken: resolverSecret,
      codexbarDelegatedProviders: [' CODEX ']
    }),
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult('unexpected-delegation');
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [nativeRow('unexpected-native')];
    }
  }));

  try {
    const result = await runtime.refresh({ provider: 'codex' }, 'manual');

    assert.deepEqual({ dashboardFetches, nativeProbes }, { dashboardFetches: 0, nativeProbes: 0 });
    assert.deepEqual(result.error, { code: 'ownership-mismatch', status: 'unavailable' });
    assert.equal(Object.getPrototypeOf(result.error), Object.prototype);
    assert.equal(Object.hasOwn(result.error, 'message'), false);
    const publicSurface = JSON.stringify({
      diagnostics: runtime.getDiagnostics(),
      error: result.error,
      snapshot: runtime.getSnapshot()
    });
    assert.equal(publicSurface.includes(resolverSecret), false);
  } finally {
    runtime.stop();
  }
});

test('CodexBar owner rejects a normalized URL ownership contradiction without probing', async () => {
  const capturedUrl = 'http://127.0.0.1:8080';
  const contradictoryUrl = 'http://127.0.0.1:9090';
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions({
    codexbarDashboardUrl: ` ${capturedUrl} `
  }), runtimeDeps({
    resolveConfigSnapshot: async () => ({
      codexbarDashboardUrl: ` ${contradictoryUrl} `
    }),
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult('unexpected-dashboard');
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [nativeRow('unexpected-native')];
    }
  }));

  try {
    const result = await runtime.refresh({ provider: 'codex' }, 'manual');
    const row = runtime.getSnapshot().providers[0];

    assert.deepEqual({ dashboardFetches, nativeProbes }, { dashboardFetches: 0, nativeProbes: 0 });
    assert.deepEqual(result.error, { code: 'ownership-mismatch', status: 'unavailable' });
    assert.equal(Object.getPrototypeOf(result.error), Object.prototype);
    assert.equal(Object.hasOwn(result.error, 'message'), false);
    assert.deepEqual(
      { producer: row.producer, provider: row.provider, status: row.status, windows: row.windows },
      { producer: 'codexbar', provider: 'codex', status: 'unavailable', windows: [] }
    );
    assert.equal(JSON.stringify({ error: result.error, row }).includes(DASHBOARD_TOKEN), false);
  } finally {
    runtime.stop();
  }
});

test('reconfigure is the only owner transition and fences the pending native generation', async () => {
  const oldNative = deferred();
  const updates = [];
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions({
    codexbarDashboardEnabled: false
  }), runtimeDeps({
    resolveConfigSnapshot: async () => ({ limitsRefreshMode: 'fixed' }),
    onUpdate: (snapshot) => updates.push(snapshot),
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult('replacement-codexbar');
    },
    probeProvider: async () => {
      nativeProbes += 1;
      if (nativeProbes === 1) return oldNative.promise;
      return [nativeRow('unexpected-replacement-native')];
    }
  }));
  const pendingNative = runtime.refresh({ provider: 'codex' }, 'manual');

  try {
    await waitFor(() => nativeProbes === 1, 'the pending native probe to start');
    runtime.reconfigure({
      codexbarDashboardEnabled: true,
      codexbarDashboardUrl: 'http://127.0.0.1:9090',
      codexbarDashboardToken: 'replacement-token',
      codexbarDelegatedProviders: ['codex']
    });

    assert.equal((await pendingNative).superseded, true);
    oldNative.resolve([nativeRow('superseded-native-marker')]);
    await waitFor(
      () => runtime.getDiagnostics().active === 0 && (dashboardFetches === 1 || nativeProbes > 1),
      'the replacement ownership generation to finish'
    );

    assert.deepEqual({ dashboardFetches, nativeProbes }, { dashboardFetches: 1, nativeProbes: 1 });
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { producer: rows[0].producer, producerVersion: rows[0].producerVersion },
      { producer: 'codexbar', producerVersion: 'replacement-codexbar' }
    );
    assert.equal(JSON.stringify(updates).includes('superseded-native-marker'), false);
  } finally {
    oldNative.resolve([nativeRow('cleanup-native')]);
    runtime.stop();
    await Promise.allSettled([pendingNative]);
  }
});
