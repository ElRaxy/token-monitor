'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'codexbar-dashboard-v1',
  'codexbar-0.55.0-redacted.json'
);
const NOW_MS = Date.parse('2026-08-25T08:01:00.000Z');
const OBSERVED_AT = '2026-08-25T08:01:00.000Z';

function adapter() {
  return require('../../src/shared/codexbarDashboard');
}

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function diagnosticCore(diagnostic) {
  return {
    code: diagnostic?.code,
    httpStatus: diagnostic?.httpStatus,
    schemaVersion: diagnostic?.schemaVersion,
    providerId: diagnostic?.providerId,
    observedAt: diagnostic?.observedAt
  };
}

async function captureError(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected a typed CodexBar dashboard error');
}

function assertSafeError(error, ErrorType, expected) {
  assert.ok(error instanceof ErrorType);
  assert.deepEqual(diagnosticCore(error), {
    code: expected.code,
    httpStatus: expected.httpStatus ?? null,
    schemaVersion: expected.schemaVersion ?? null,
    providerId: null,
    observedAt: OBSERVED_AT
  });
  const publicText = `${error.message}\n${JSON.stringify(error)}`;
  assert.doesNotMatch(publicText, /fixture-bearer-not-a-secret|server-private-marker/);
}

async function withDashboardServer(run) {
  let mode = 'ok';
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      accept: request.headers.accept,
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url
    });
    response.setHeader('content-type', 'application/json');
    if (mode === 'unauthorized') {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'server-private-marker' }));
      return;
    }
    if (mode === 'invalid-json') {
      response.end('{"server-private-marker":');
      return;
    }
    if (mode === 'payload-too-large') {
      response.end(JSON.stringify({ padding: 'x'.repeat(4096) }));
      return;
    }
    if (mode === 'incompatible-schema') {
      response.end(JSON.stringify({ ...fixture(), schemaVersion: 2 }));
      return;
    }
    if (mode === 'timeout') {
      setTimeout(() => response.end(JSON.stringify(fixture())), 100);
      return;
    }
    response.end(JSON.stringify(fixture()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({
      baseUrl,
      requests,
      setMode(value) {
        mode = value;
      }
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('R1 normaliza dashboard-v1 válido con procedencia y frescura', () => {
  const { parseCodexBarDashboardSnapshot } = adapter();
  const result = parseCodexBarDashboardSnapshot(fixture(), {
    nowMs: NOW_MS,
    refreshMs: 90_000
  });

  assert.deepEqual(result.meta, {
    schemaVersion: 1,
    producer: 'codexbar',
    producerVersion: '0.55.0',
    generatedAt: '2026-08-25T08:00:00.000Z',
    staleAfterMs: 180_000
  });
  assert.equal(result.limits.updatedAt, '2026-08-25T08:00:00.000Z');
  assert.equal(result.limits.refreshMs, 90_000);
  assert.deepEqual(result.limits.providers.map((provider) => provider.provider), [
    'codex',
    'claude',
    'volcengine'
  ]);
  assert.deepEqual(result.diagnostics, []);

  const codex = result.limits.providers[0];
  assert.equal(codex.status, 'ok');
  assert.equal(codex.source, 'oauth');
  assert.equal(codex.producer, 'codexbar');
  assert.equal(codex.producerVersion, '0.55.0');
  assert.equal(codex.producedAt, '2026-08-25T08:00:00.000Z');
  assert.equal(codex.staleAfterMs, 180_000);
  const sessionWindow = codex.windows.find((window) => window.kind === 'session');
  assert.ok(sessionWindow);
  assert.equal(sessionWindow.usedPercent, 25);
  assert.equal(sessionWindow.remainingPercent, 75);
  assert.equal(sessionWindow.resetsAt, '2026-08-25T13:00:00.000Z');
});

test('R2 tolera extensiones y providers desconocidos sin perder filas válidas', () => {
  const { parseCodexBarDashboardSnapshot } = adapter();
  const payload = fixture();
  payload.additiveTopLevelField = { future: true };
  payload.providers[0].additiveProviderField = ['future'];
  payload.providers[0].windows[0].additiveWindowField = 1;
  payload.providers.splice(1, 0, {
    id: 'future-provider',
    enabled: true,
    source: 'api',
    windows: [{ kind: 'session', usedPercent: 50, remainingPercent: 50 }],
    updatedAt: '2026-08-25T08:00:00Z'
  });

  const result = parseCodexBarDashboardSnapshot(payload, {
    nowMs: NOW_MS,
    refreshMs: 90_000
  });

  assert.deepEqual(result.limits.providers.map((provider) => provider.provider), [
    'codex',
    'claude',
    'volcengine'
  ]);
  assert.equal(result.limits.providers[0].windows[0].usedPercent, 25);
  assert.deepEqual(result.diagnostics.map(diagnosticCore), [{
    code: 'unknown-provider',
    httpStatus: null,
    schemaVersion: 1,
    providerId: 'future-provider',
    observedAt: OBSERVED_AT
  }]);
});

test('R3 aplica solo aliases explícitos respaldados por fixture', () => {
  const { parseCodexBarDashboardSnapshot } = adapter();
  const aliased = parseCodexBarDashboardSnapshot(fixture(), {
    nowMs: NOW_MS,
    refreshMs: 90_000
  });
  const volcengine = aliased.limits.providers.find((provider) => provider.provider === 'volcengine');
  assert.ok(volcengine);
  assert.equal(volcengine.source, 'api');
  assert.equal(volcengine.windows[0].kind, 'billing');
  assert.equal(volcengine.windows[0].remainingPercent, 65);

  const ambiguousPayload = fixture();
  ambiguousPayload.providers.push({
    id: 'volcengine',
    name: 'Volcengine',
    enabled: true,
    source: 'api',
    status: { level: 'ok', updatedAt: '2026-08-25T07:56:00Z' },
    windows: [{
      kind: 'billing',
      label: 'Direct coding plan',
      usedPercent: 20,
      remainingPercent: 80,
      resetAt: '2026-09-01T00:00:00Z'
    }],
    updatedAt: '2026-08-25T07:56:30Z'
  });
  const ambiguous = parseCodexBarDashboardSnapshot(ambiguousPayload, {
    nowMs: NOW_MS,
    refreshMs: 90_000
  });
  const canonicalRows = ambiguous.limits.providers.filter((provider) => provider.provider === 'volcengine');
  assert.equal(canonicalRows.length, 1);
  assert.equal(canonicalRows[0].windows[0].remainingPercent, 80);
  assert.deepEqual(
    ambiguous.diagnostics.map(diagnosticCore).filter((entry) => entry.code === 'ambiguous-alias'),
    [{
      code: 'ambiguous-alias',
      httpStatus: null,
      schemaVersion: 1,
      providerId: 'doubao',
      observedAt: OBSERVED_AT
    }]
  );
});

test('R4 falla cerrado ante transporte o respuesta insegura', async () => {
  const {
    CodexBarDashboardError,
    fetchCodexBarDashboard,
    normalizeCodexBarDashboardUrl
  } = adapter();
  assert.equal(
    normalizeCodexBarDashboardUrl('http://127.0.0.1:8080/'),
    'http://127.0.0.1:8080'
  );
  assert.equal(
    normalizeCodexBarDashboardUrl('http://localhost:8080'),
    'http://localhost:8080'
  );
  assert.equal(
    normalizeCodexBarDashboardUrl('http://127.0.0.2:8080'),
    'http://127.0.0.2:8080'
  );
  for (const value of [
    'https://127.0.0.1:8080',
    'http://[::1]:8080',
    'http://0.0.0.0:8080',
    'http://192.0.2.1:8080',
    'http://codexbar.localhost:8080',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080/custom-path',
    'http://127.0.0.1:8080?token=fixture-bearer-not-a-secret',
    'http://127.0.0.1:8080#fragment'
  ]) {
    assert.throws(
      () => normalizeCodexBarDashboardUrl(value),
      (error) => error instanceof CodexBarDashboardError && error.code === 'unsafe-url'
    );
  }

  let unsafeFetchCalls = 0;
  const unsafeError = await captureError(() => fetchCodexBarDashboard({
    baseUrl: 'http://192.0.2.1:8080',
    token: 'fixture-bearer-not-a-secret',
    fetchImpl: async () => {
      unsafeFetchCalls += 1;
      throw new Error('must not run');
    },
    nowMs: NOW_MS
  }));
  assertSafeError(unsafeError, CodexBarDashboardError, { code: 'unsafe-url' });
  assert.equal(unsafeFetchCalls, 0);

  const missingTokenError = await captureError(() => fetchCodexBarDashboard({
    baseUrl: 'http://127.0.0.1:8080',
    token: '',
    fetchImpl: async () => {
      unsafeFetchCalls += 1;
      throw new Error('must not run');
    },
    nowMs: NOW_MS
  }));
  assertSafeError(missingTokenError, CodexBarDashboardError, { code: 'unauthorized' });
  assert.equal(unsafeFetchCalls, 0);

  await withDashboardServer(async ({ baseUrl, requests, setMode }) => {
    const options = {
      baseUrl,
      token: 'fixture-bearer-not-a-secret',
      fetchImpl: fetch,
      nowMs: NOW_MS,
      refreshMs: 90_000
    };
    const success = await fetchCodexBarDashboard(options);
    assert.equal(success.meta.producer, 'codexbar');
    assert.deepEqual(requests[0], {
      accept: 'application/json',
      authorization: 'Bearer fixture-bearer-not-a-secret',
      method: 'GET',
      url: '/dashboard/v1/snapshot'
    });

    setMode('unauthorized');
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard(options)),
      CodexBarDashboardError,
      { code: 'unauthorized', httpStatus: 401 }
    );

    setMode('invalid-json');
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard(options)),
      CodexBarDashboardError,
      { code: 'invalid-json', httpStatus: 200 }
    );

    setMode('payload-too-large');
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard({ ...options, maxBytes: 128 })),
      CodexBarDashboardError,
      { code: 'payload-too-large', httpStatus: 200 }
    );

    setMode('incompatible-schema');
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard(options)),
      CodexBarDashboardError,
      { code: 'incompatible-schema', httpStatus: 200, schemaVersion: 2 }
    );

    const stalePayload = fixture();
    stalePayload.generatedAt = '2026-08-25T07:57:59.999Z';
    assertSafeError(
      await captureError(() => Promise.resolve(adapter().parseCodexBarDashboardSnapshot(stalePayload, {
        nowMs: NOW_MS,
        refreshMs: 90_000
      }))),
      CodexBarDashboardError,
      { code: 'stale', schemaVersion: 1 }
    );

    setMode('timeout');
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard({ ...options, timeoutMs: 10 })),
      CodexBarDashboardError,
      { code: 'timeout' }
    );

    const controller = new AbortController();
    controller.abort();
    assertSafeError(
      await captureError(() => fetchCodexBarDashboard({
        ...options,
        signal: controller.signal,
        timeoutMs: 1000
      })),
      CodexBarDashboardError,
      { code: 'aborted' }
    );
  });
});
