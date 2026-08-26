'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const { createHub } = require('../../src/hub/server');
const { createDeviceRuntime } = require('../../src/shared/deviceRuntime');
const { createOrderedSink } = require('../../src/shared/orderedSink');
const { postSyncPayload } = require('../../src/shared/syncPayload');

function timeout(promise, label, ms = 3_000) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        return {
          event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || '',
          data: JSON.parse(data),
          raw: frame
        };
      }
      const chunk = await timeout(reader.read(), 'SSE frame');
      if (chunk.done) throw new Error('SSE stream ended before the expected frame');
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
    }
  }

  return {
    next,
    cancel: () => reader.cancel().catch(() => {})
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

test('R14 dashboard-v1 llega a Hub SSE sin probe nativo ni pérdida de uso', { timeout: 10_000 }, async () => {
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const usageUpdatedAt = new Date(nowMs - 1_000).toISOString();
  const resetAt = new Date(nowMs + 60 * 60_000).toISOString();
  const dashboardToken = 'dashboard-bearer-r14-private';
  const hubSecret = 'hub-secret-r14-private';
  const identityMarker = 'redacted-r14@example.invalid';
  const costMarker = 'dashboard-cost-marker-r14';
  const tokenMarker = 'dashboard-tokens-marker-r14';
  const sessionMarker = 'dashboard-session-marker-r14';
  const requests = [];
  const postedPayloads = [];
  let nativeProbeCalls = 0;
  let usageOptions;
  let runtime;
  let hub;
  let stream;
  let dashboardServer;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codexbar-r14-'));
  const dataFile = path.join(tempDir, 'devices.json');

  try {
    dashboardServer = http.createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        schemaVersion: 1,
        generatedAt,
        staleAfterSeconds: 300,
        host: { codexBarVersion: '0.55.0' },
        providers: [
          {
            id: 'codex',
            enabled: true,
            source: 'oauth',
            identity: { accountEmail: identityMarker },
            windows: [{ kind: 'session', usedPercent: 25, resetAt }],
            cost: { marker: costMarker },
            tokens: { marker: tokenMarker },
            sessions: [{ id: sessionMarker }],
            error: null,
            updatedAt: generatedAt
          },
          {
            id: 'claude',
            enabled: true,
            source: 'cli',
            identity: { accountEmail: identityMarker },
            windows: [{ kind: 'weekly', usedPercent: 40, resetAt }],
            cost: { marker: costMarker },
            tokens: { marker: tokenMarker },
            sessions: [{ id: sessionMarker }],
            error: null,
            updatedAt: generatedAt
          }
        ]
      }));
    });
    dashboardServer.listen(0, '127.0.0.1');
    await once(dashboardServer, 'listening');
    const dashboardUrl = `http://127.0.0.1:${dashboardServer.address().port}`;

    hub = createHub({
      port: 0,
      host: '127.0.0.1',
      secret: hubSecret,
      staleAfterMs: 10 * 60_000,
      dataFile,
      logger: { error() {}, warn() {} }
    });
    await hub.start();
    const hubUrl = `http://127.0.0.1:${hub.server.address().port}`;
    const headers = {
      authorization: `Bearer ${hubSecret}`,
      'content-type': 'application/json'
    };
    const sseResponse = await fetch(`${hubUrl}/api/stats/stream`, { headers });
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type') || '', /text\/event-stream/);
    stream = sseReader(sseResponse);
    assert.equal((await stream.next()).event, 'snapshot');

    const sink = createOrderedSink({
      async send(record) {
        const { response, payload } = await postSyncPayload(fetch, `${hubUrl}/api/ingest`, {
          headers,
          summary: record
        });
        postedPayloads.push(payload);
        const body = await response.json();
        if (!response.ok) throw new Error(`Hub ingest failed: ${response.status} ${body.error || ''}`);
      }
    });

    runtime = createDeviceRuntime({
      envelope: {
        deviceId: 'r14-device',
        hostname: 'r14-host',
        platform: 'darwin-arm64',
        agentVersion: 'r14-test',
        agentRuntime: 'headless-agent'
      },
      sink,
      limitsOptions: {
        limitsEnabled: true,
        limitProviders: ['codex', 'claude'],
        codexbarDashboardEnabled: true,
        codexbarDashboardUrl: dashboardUrl,
        codexbarDashboardToken: dashboardToken,
        codexbarDelegatedProviders: ['codex', 'claude']
      }
    }, {
      createUsageRuntime(options) {
        usageOptions = options;
        return {
          getDiagnostics: () => ({ state: 'idle' }),
          refreshClient: async () => true,
          stop() {},
          tick: async () => true
        };
      },
      limitsDeps: {
        autoRetry: false,
        autoStart: false,
        cleanupGraceMs: 0,
        codexbarFetch: fetch,
        now: () => nowMs,
        providerPhysicalBoundMs: () => 1_000,
        probeProvider: async () => {
          nativeProbeCalls += 1;
          return [];
        }
      }
    });

    const usage = {
      updatedAt: usageUpdatedAt,
      today: { totalTokens: 101, clients: { codex: 101 } },
      month: { totalTokens: 202, clients: { codex: 202 } },
      allTime: { totalTokens: 303, clients: { codex: 303 } }
    };
    usageOptions.onUpdate(usage, 'startup');
    await runtime.flush();
    const usageFrame = await stream.next();
    assert.equal(usageFrame.data.reason, 'ingest');
    assert.equal(usageFrame.data.stats.periods.today.totalTokens, 101);

    await runtime.refreshLimits({}, 'manual');
    await runtime.flush();
    let limitsFrame;
    for (let index = 0; index < 4; index += 1) {
      const candidate = await stream.next();
      if (candidate.data.stats.limits.providers.length === 2) {
        limitsFrame = candidate;
        break;
      }
    }
    assert.ok(limitsFrame, 'expected an SSE frame containing both delegated providers');

    assert.deepEqual(requests, [{
      authorization: `Bearer ${dashboardToken}`,
      method: 'GET',
      url: '/dashboard/v1/snapshot'
    }]);
    assert.equal(nativeProbeCalls, 0);
    assert.equal(postedPayloads.length >= 2, true);

    const stats = limitsFrame.data.stats;
    assert.deepEqual({
      today: stats.periods.today.totalTokens,
      month: stats.periods.month.totalTokens,
      allTime: stats.periods.allTime.totalTokens,
      updatedAt: stats.devices[0].updatedAt
    }, {
      today: 101,
      month: 202,
      allTime: 303,
      updatedAt: usageUpdatedAt
    });

    const providers = stats.limits.providers;
    assert.deepEqual(providers.map((provider) => provider.provider), ['claude', 'codex']);
    for (const provider of providers) {
      assert.equal(provider.producer, 'codexbar');
      assert.equal(provider.producerVersion, '0.55.0');
      assert.equal(provider.producedAt, generatedAt);
      assert.equal(provider.staleAfterMs, 300_000);
      assert.equal(provider.sourceDeviceId, 'r14-device');
      for (const key of [
        'accountKey',
        'accountEmail',
        'accountName',
        'accountLabel',
        'planLabel'
      ]) assert.equal(provider[key], '', `${provider.provider}.${key}`);
      for (const key of [
        'identity',
        'cost',
        'tokens',
        'sessions'
      ]) assert.equal(Object.hasOwn(provider, key), false, `${provider.provider}.${key}`);
    }
    assert.equal(providers.find((provider) => provider.provider === 'codex').source, 'oauth');
    assert.equal(providers.find((provider) => provider.provider === 'claude').source, 'cli');

    const storedText = fs.readFileSync(dataFile, 'utf8');
    const publishedText = `${JSON.stringify(limitsFrame.data)}\n${storedText}`;
    for (const privateValue of [
      dashboardToken,
      hubSecret,
      identityMarker,
      costMarker,
      tokenMarker,
      sessionMarker
    ]) assert.doesNotMatch(publishedText, new RegExp(privateValue));
  } finally {
    runtime?.stop();
    await stream?.cancel();
    await hub?.stop();
    await closeServer(dashboardServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
