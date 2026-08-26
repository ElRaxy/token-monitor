'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCodexBarSummaryServer } = require('../../src/electron/codexbarSummaryServer');

const ROUTE = '/api/integrations/codexbar/v1/summary';
const TOKEN = 'test-only-dedicated-summary-token';
const NOW_MS = Date.parse('2026-08-26T08:10:20.900Z');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function latestStats() {
  return deepFreeze({
    updatedAt: '2099-12-31T23:59:59.000Z',
    devices: [{
      deviceId: 'must-not-leak',
      hostname: 'must-not-leak',
      receivedAt: '2026-08-26T08:10:12.100Z',
      stale: false
    }],
    periods: {
      today: {
        totalTokens: 1_250_000,
        costUsd: 3.41,
        sessions: { private: { id: 'must-not-leak' } },
        projects: { private: { tokens: 1_250_000 } },
        models: { 'gpt-5': 1_250_000 }
      },
      month: {
        totalTokens: 18_400_000,
        costUsd: 42.1,
        sessions: { private: { id: 'must-not-leak' } },
        projects: { private: { tokens: 18_400_000 } },
        models: { 'gpt-5': 18_400_000 }
      }
    },
    limits: { providers: [{ provider: 'codex', remainingPercent: 42 }] },
    secrets: { hubHostSecret: 'must-not-leak' }
  });
}

function requestHeaders(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function assertResponsePolicy(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const [name] of response.headers) {
    assert.doesNotMatch(name, /^access-control-/i, `unexpected CORS header: ${name}`);
  }
}

async function assertBoundedError(response, status, code) {
  assert.equal(response.status, status);
  assertResponsePolicy(response);
  const text = await response.text();
  assert.ok(Buffer.byteLength(text, 'utf8') <= 160, `error body is too large: ${text.length}`);
  assert.deepEqual(JSON.parse(text), { error: { code } });
  assert.doesNotMatch(text, /test-only|must-not-leak|stack|Error:/i);
}

async function withSummaryServer(options, run) {
  const bridge = createCodexBarSummaryServer({
    token: TOKEN,
    port: 0,
    now: () => NOW_MS,
    producerVersion: '0.48.0',
    logger: { error() {}, warn() {}, info() {} },
    ...options
  });
  await bridge.start();
  try {
    const address = bridge.server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, bridge });
  } finally {
    await bridge.stop();
  }
}

test('R17/R19 serves two cache-only GETs without mutating latestStats or invoking refresh/probe bait', async () => {
  const snapshot = latestStats();
  const before = JSON.stringify(snapshot);
  let snapshotReads = 0;
  let refreshCalls = 0;
  let probeCalls = 0;

  await withSummaryServer({
    getSnapshot() {
      snapshotReads += 1;
      return snapshot;
    },
    refreshStats() {
      refreshCalls += 1;
      throw new Error('refresh must never run from a summary GET');
    },
    probeLimits() {
      probeCalls += 1;
      throw new Error('probe must never run from a summary GET');
    }
  }, async ({ baseUrl }) => {
    for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
      const response = await fetch(`${baseUrl}${ROUTE}`, {
        headers: requestHeaders()
      });
      assert.equal(response.status, 200);
      assertResponsePolicy(response);
      assert.deepEqual(await response.json(), {
        schemaVersion: 1,
        generatedAt: '2026-08-26T08:10:20.900Z',
        producer: { id: 'token-monitor', version: '0.48.0' },
        freshness: {
          observedAt: '2026-08-26T08:10:12.100Z',
          ageSeconds: 8,
          sourceCount: 1,
          staleSourceCount: 0
        },
        periods: {
          today: { totalTokens: 1_250_000, costUsd: 3.41 },
          month: { totalTokens: 18_400_000, costUsd: 42.1 }
        }
      });
    }
  });

  assert.equal(snapshotReads, 2);
  assert.equal(refreshCalls, 0);
  assert.equal(probeCalls, 0);
  assert.equal(JSON.stringify(snapshot), before);
});

test('R18 accepts only the exact authenticated GET route and rejects browser Origin', async () => {
  await withSummaryServer({ getSnapshot: () => latestStats() }, async ({ baseUrl }) => {
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}`),
      401,
      'unauthorized'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}`, { headers: requestHeaders('wrong-token') }),
      401,
      'unauthorized'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}?token=${encodeURIComponent(TOKEN)}`),
      404,
      'not-found'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}?view=compact`, { headers: requestHeaders() }),
      404,
      'not-found'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}/`, { headers: requestHeaders() }),
      404,
      'not-found'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}`, { method: 'POST', headers: requestHeaders() }),
      404,
      'not-found'
    );
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}`, {
        headers: { ...requestHeaders(), origin: 'https://attacker.example' }
      }),
      403,
      'origin-not-allowed'
    );
  });
});

test('R18 returns a bounded 503 without CORS while the in-memory snapshot is unavailable', async () => {
  await withSummaryServer({ getSnapshot: () => null }, async ({ baseUrl }) => {
    await assertBoundedError(
      await fetch(`${baseUrl}${ROUTE}`, { headers: requestHeaders() }),
      503,
      'snapshot-unavailable'
    );
  });
});
