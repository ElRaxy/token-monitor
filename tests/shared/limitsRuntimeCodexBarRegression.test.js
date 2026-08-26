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

function fakeClock(startMs = NOW_MS) {
  let current = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, {
        at: current + Math.max(0, Number(delayMs) || 0),
        callback
      });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      current += ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) return;
        timers.delete(next[0]);
        next[1].callback();
      }
    },
    pendingDelays() {
      return [...timers.values()]
        .map((timer) => timer.at - current)
        .sort((left, right) => left - right);
    }
  };
}

function runtimeOptions(overrides = {}) {
  return {
    limitsEnabled: true,
    limitProviders: ['codex'],
    codexbarDashboardEnabled: true,
    codexbarDashboardUrl: 'http://127.0.0.1:8080',
    codexbarDashboardToken: DASHBOARD_TOKEN,
    codexbarDelegatedProviders: 'codex,claude',
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
    providerPhysicalBoundMs: () => 100,
    ...overrides
  };
}

function dashboardResult(options = {}) {
  const producedAt = options.producedAt || new Date(NOW_MS).toISOString();
  const staleAfterMs = options.staleAfterMs ?? 10_000;
  const providers = options.providers || ['codex'];
  return {
    limits: {
      updatedAt: producedAt,
      refreshMs: 90_000,
      providers: providers.map((provider, index) => ({
        provider,
        source: provider === 'codex' ? 'oauth' : 'web',
        status: 'ok',
        updatedAt: producedAt,
        windows: [{
          kind: 'session',
          label: `${provider} fixture`,
          usedPercent: 20 + index
        }],
        ...(options.balance ? { balance: { ...options.balance } } : {}),
        producer: 'codexbar',
        producerVersion: '0.55.0',
        producedAt,
        staleAfterMs
      }))
    },
    meta: {
      schemaVersion: 1,
      producer: 'codexbar',
      producerVersion: '0.55.0',
      generatedAt: producedAt,
      staleAfterMs
    },
    diagnostics: []
  };
}

test('CodexBar does not fetch after stop or reconfigure fences pending config resolution', async () => {
  for (const action of ['stop', 'reconfigure']) {
    const configResolution = deferred();
    const configStarted = deferred();
    const probeFinished = deferred();
    let capturedConfig;
    let dashboardFetches = 0;
    let nativeProbes = 0;
    const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
      resolveConfigSnapshot: (_scope, currentConfig) => {
        capturedConfig = currentConfig;
        configStarted.resolve();
        return configResolution.promise;
      },
      fetchCodexBarDashboard: async () => {
        dashboardFetches += 1;
        return dashboardResult();
      },
      probeProvider: async () => {
        nativeProbes += 1;
        return [];
      },
      onEvent(event) {
        if (event.type === 'probe-finish') probeFinished.resolve();
      }
    }));

    const pending = runtime.refresh({ provider: 'codex' }, 'manual');
    await configStarted.promise;
    if (action === 'stop') runtime.stop();
    else runtime.reconfigure({ limitsEnabled: false });
    configResolution.resolve(capturedConfig);

    const result = await pending;
    await probeFinished.promise;
    assert.equal(result.superseded, true, action);
    assert.deepEqual({ dashboardFetches, nativeProbes }, {
      dashboardFetches: 0,
      nativeProbes: 0
    }, action);
    runtime.stop();
  }
});

test('a full serial CodexBar refresh fetches once per batch and again for the next batch', async () => {
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions({
    limitProviders: ['codex', 'claude']
  }), runtimeDeps({
    maxConcurrency: 1,
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult({ providers: ['codex', 'claude'] });
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [];
    }
  }));

  try {
    await runtime.refresh({}, 'manual');
    assert.deepEqual({ dashboardFetches, nativeProbes }, {
      dashboardFetches: 1,
      nativeProbes: 0
    });
    assert.deepEqual(
      runtime.getSnapshot().providers.map((row) => row.provider).sort(),
      ['claude', 'codex']
    );

    await runtime.refresh({}, 'manual');
    assert.deepEqual({ dashboardFetches, nativeProbes }, {
      dashboardFetches: 2,
      nativeProbes: 0
    });
  } finally {
    runtime.stop();
  }
});

test('CodexBar last-good expires autonomously only after the exact TTL boundary', async () => {
  const clock = fakeClock();
  let dashboardFetches = 0;
  const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult({
        producedAt: new Date(clock.now()).toISOString(),
        staleAfterMs: 1_000,
        balance: { amount: 5, currency: 'CREDITS' }
      });
    }
  }));

  try {
    await runtime.refresh({ provider: 'codex' }, 'manual');
    clock.advance(1_000);
    const atBoundary = runtime.getSnapshot().providers[0];
    assert.equal(atBoundary.status, 'ok');
    assert.ok(atBoundary.windows.length > 0);
    assert.equal(atBoundary.balance.amount, 5);
    assert.equal(dashboardFetches, 1);

    clock.advance(1);
    const expired = runtime.getSnapshot().providers[0];
    assert.equal(expired.status, 'unavailable');
    assert.deepEqual(expired.windows, []);
    assert.equal(expired.balance, null);
    assert.equal(dashboardFetches, 1);
  } finally {
    runtime.stop();
  }
});

test('account-scoped CodexBar refreshes collapse into one provider-global row', async () => {
  let dashboardFetches = 0;
  let nativeProbes = 0;
  const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      return dashboardResult();
    },
    probeProvider: async () => {
      nativeProbes += 1;
      return [];
    }
  }));

  try {
    const accountA = runtime.refresh({ provider: 'codex', accountKey: 'account-a' }, 'account-state');
    const accountB = runtime.refresh({ provider: 'codex', accountKey: 'account-b' }, 'account-state');
    const [first, second] = await Promise.all([accountA, accountB]);
    const rows = runtime.getSnapshot().providers;

    assert.equal(first.superseded, true);
    assert.equal(second.superseded, false);
    assert.deepEqual({ dashboardFetches, nativeProbes }, {
      dashboardFetches: 1,
      nativeProbes: 0
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'codex');
    assert.equal(rows[0].accountKey, '');
    assert.equal(rows[0].accountLabel, '');
  } finally {
    runtime.stop();
  }
});

test('CodexBar unauthorized stays typed, terminal, and secret-free', async () => {
  const clock = fakeClock();
  const serverMessage = `rejected bearer ${DASHBOARD_TOKEN}`;
  let dashboardFetches = 0;
  const runtime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    autoRetry: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetchCodexBarDashboard: async () => {
      dashboardFetches += 1;
      const error = new Error(serverMessage);
      error.code = 'unauthorized';
      error.status = 'unauthorized';
      throw error;
    }
  }));

  try {
    const result = await runtime.refresh({ provider: 'codex' }, 'manual');
    const snapshot = runtime.getSnapshot();
    const diagnostics = runtime.getDiagnostics();

    assert.equal(snapshot.providers[0].status, 'unauthorized');
    assert.equal(result.error.code, 'unauthorized');
    assert.equal(result.error.status, 'unauthorized');
    assert.equal(Object.hasOwn(result.error, 'message'), false);
    assert.equal(diagnostics.providers[0].lastFailureCode, 'unauthorized');
    assert.equal(diagnostics.providers[0].retryAttempt, 0);
    assert.equal(diagnostics.providers[0].retryAt, null);
    assert.deepEqual(clock.pendingDelays(), []);

    const publicState = JSON.stringify({ diagnostics, error: result.error, snapshot });
    assert.equal(publicState.includes(DASHBOARD_TOKEN), false);
    assert.equal(publicState.includes(serverMessage), false);
    clock.advance(60_000);
    assert.equal(dashboardFetches, 1);
  } finally {
    runtime.stop();
  }
});

test('generic deps.fetch never reaches CodexBar but remains available to native probes', async () => {
  let genericFetchCalls = 0;
  let dashboardOptions;
  let nativeProbeDeps;
  const genericFetch = async () => {
    genericFetchCalls += 1;
    throw new Error('generic fetch proxy must not be called by this test');
  };
  const delegatedRuntime = createLimitsRuntime(runtimeOptions(), runtimeDeps({
    fetch: genericFetch,
    fetchCodexBarDashboard: async (options) => {
      dashboardOptions = options;
      return dashboardResult();
    }
  }));

  try {
    await delegatedRuntime.refresh({ provider: 'codex' }, 'manual');
    assert.equal(genericFetchCalls, 0);
    assert.equal(Object.hasOwn(dashboardOptions, 'fetchImpl'), false);
  } finally {
    delegatedRuntime.stop();
  }

  const nativeRuntime = createLimitsRuntime(runtimeOptions({
    limitProviders: ['kimi']
  }), runtimeDeps({
    fetch: genericFetch,
    probeProvider: async (_provider, _config, _context, deps) => {
      nativeProbeDeps = deps;
      return [];
    }
  }));

  try {
    await nativeRuntime.refresh({ provider: 'kimi' }, 'manual');
    assert.equal(nativeProbeDeps.fetch, genericFetch);
    assert.equal(genericFetchCalls, 0);
  } finally {
    nativeRuntime.stop();
  }
});
