'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCodexBarSummary } = require('../../src/shared/codexbarSummary');

const NOW_MS = Date.parse('2026-08-26T08:10:20.900Z');

function privateStats(overrides = {}) {
  return {
    updatedAt: '2099-12-31T23:59:59.000Z',
    identity: { email: 'private@example.test', accountKey: 'private-account' },
    limits: { providers: [{ provider: 'codex', remainingPercent: 42 }] },
    secrets: { hubHostSecret: 'private-hub-secret' },
    devices: [
      {
        deviceId: 'private-device-a',
        hostname: 'private-host-a',
        receivedAt: '2026-08-26T08:10:12.100Z',
        updatedAt: '2026-08-26T08:10:11.000Z',
        stale: false,
        paths: ['/Users/private/.codex'],
        periods: { today: { sessions: { private: { prompt: 'do not expose' } } } }
      },
      {
        deviceId: 'private-device-b',
        hostname: 'private-host-b',
        receivedAt: 'not-a-timestamp',
        updatedAt: '2026-08-26T08:10:05.000Z',
        stale: true
      }
    ],
    periods: {
      today: {
        totalTokens: 1_250_000,
        costUsd: 3.41,
        clients: { codex: 1_000_000, claude: 250_000 },
        models: { 'gpt-5': 1_250_000 },
        projects: { private: { path: '/Users/private/project' } },
        sessions: { private: { id: 'private-session' } }
      },
      month: {
        totalTokens: 18_400_000,
        costUsd: 42.1,
        clients: { codex: 18_400_000 },
        models: { 'gpt-5': 18_400_000 },
        projects: { private: { tokens: 18_400_000 } },
        sessions: { private: { id: 'private-month-session' } }
      },
      allTime: {
        totalTokens: 900_000_000,
        costUsd: 900,
        sessions: { private: { id: 'private-all-time-session' } }
      }
    },
    ...overrides
  };
}

function build(stats, options = {}) {
  return buildCodexBarSummary(stats, {
    now: () => NOW_MS,
    producerVersion: '0.48.0',
    ...options
  });
}

test('R17 projects the exact v1 allowlist and derives freshness from device observations', () => {
  const summary = build(privateStats());

  assert.deepEqual(summary, {
    schemaVersion: 1,
    generatedAt: '2026-08-26T08:10:20.900Z',
    producer: {
      id: 'token-monitor',
      version: '0.48.0'
    },
    freshness: {
      observedAt: '2026-08-26T08:10:12.100Z',
      ageSeconds: 8,
      sourceCount: 2,
      staleSourceCount: 1
    },
    periods: {
      today: {
        totalTokens: 1_250_000,
        costUsd: 3.41
      },
      month: {
        totalTokens: 18_400_000,
        costUsd: 42.1
      }
    }
  });

  assert.deepEqual(Object.keys(summary), [
    'schemaVersion',
    'generatedAt',
    'producer',
    'freshness',
    'periods'
  ]);
  assert.deepEqual(Object.keys(summary.producer), ['id', 'version']);
  assert.deepEqual(Object.keys(summary.freshness), [
    'observedAt',
    'ageSeconds',
    'sourceCount',
    'staleSourceCount'
  ]);
  assert.deepEqual(Object.keys(summary.periods), ['today', 'month']);
  assert.deepEqual(Object.keys(summary.periods.today), ['totalTokens', 'costUsd']);
  assert.deepEqual(Object.keys(summary.periods.month), ['totalTokens', 'costUsd']);
});

test('R17 does not mistake the aggregate read timestamp for source freshness', () => {
  const stats = privateStats({
    updatedAt: '2026-08-26T08:10:20.899Z',
    devices: [{
      receivedAt: '2026-08-26T07:59:59.000Z',
      updatedAt: '2026-08-26T08:00:00.000Z',
      stale: false
    }]
  });

  assert.deepEqual(build(stats).freshness, {
    observedAt: '2026-08-26T08:00:00.000Z',
    ageSeconds: 620,
    sourceCount: 1,
    staleSourceCount: 0
  });

  const withoutSourceTime = build(privateStats({
    updatedAt: '2026-08-26T08:10:20.899Z',
    devices: [{ receivedAt: 'invalid', updatedAt: '', stale: true }]
  }));
  assert.deepEqual(withoutSourceTime.freshness, {
    observedAt: null,
    ageSeconds: null,
    sourceCount: 1,
    staleSourceCount: 1
  });
});

test('R17 publishes unknown costs as null instead of claiming zero or invalid precision', () => {
  for (const costUsd of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const stats = privateStats();
    stats.periods.today.costUsd = costUsd;
    stats.periods.month.costUsd = costUsd;
    const summary = build(stats);
    assert.equal(summary.periods.today.costUsd, null);
    assert.equal(summary.periods.month.costUsd, null);
  }
});

test('R17 never serializes identities, sessions, projects, models, limits, paths, or secrets', () => {
  const serialized = JSON.stringify(build(privateStats()));

  assert.ok(Buffer.byteLength(serialized, 'utf8') < 2 * 1024);
  assert.doesNotMatch(
    serialized,
    /identity|account|email|deviceId|hostname|session|project|model|limit|path|secret|prompt|private/i
  );
});
