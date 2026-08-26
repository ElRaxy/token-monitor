'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const PLUGIN_PATH = path.join(ROOT, 'integrations/codexbar/token-monitor.js');
const SUMMARY_PATH = '/api/integrations/codexbar/v1/summary';
const PRIVATE_MARKER = 'server-private-marker';
const SECRET_MARKER = 'fixture-summary-secret';

function pluginSource() {
  assert.ok(fs.existsSync(PLUGIN_PATH), 'R21 requires integrations/codexbar/token-monitor.js');
  return fs.readFileSync(PLUGIN_PATH, 'utf8');
}

function loadPlugin() {
  let definition = null;
  vm.runInNewContext(pluginSource(), {
    defineProvider(value) {
      assert.equal(definition, null, 'defineProvider must be called exactly once');
      definition = value;
    }
  }, { filename: PLUGIN_PATH, timeout: 1_000 });
  assert.ok(definition, 'the plugin must call defineProvider once');
  return definition;
}

function validPayload() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-26T08:30:00.000Z',
    producer: { id: 'token-monitor', version: '0.48.0' },
    freshness: {
      observedAt: '2026-08-26T08:29:52.000Z',
      ageSeconds: 8,
      sourceCount: 2,
      staleSourceCount: 0
    },
    periods: {
      today: { totalTokens: 1_245_800, costUsd: 3.41 },
      month: { totalTokens: 18_402_110, costUsd: 42.1 }
    }
  };
}

function classifiedError(code, message, options) {
  const error = new Error(String(message || code));
  error.code = code;
  if (options !== undefined) error.options = options;
  return error;
}

function contextFor(response, options = {}) {
  const requests = [];
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:17322/';
  const ctx = {
    settings: {
      get(key) {
        assert.equal(key, 'BASE_URL');
        return baseUrl;
      },
      getSecret() {
        assert.fail('the host injects bearer auth; plugin code must not read SUMMARY_TOKEN');
      }
    },
    http: {
      async getJSON(url, requestOptions) {
        requests.push({ url, options: requestOptions });
        return response;
      }
    },
    fail: {
      authenticationExpired: (message, failOptions) => classifiedError('authenticationExpired', message, failOptions),
      missingCredential: (message, failOptions) => classifiedError('missingCredential', message, failOptions),
      permissionDenied: (message, failOptions) => classifiedError('permissionDenied', message, failOptions),
      providerUnavailable: (message, failOptions) => classifiedError('providerUnavailable', message, failOptions),
      parseFailure: (message, failOptions) => classifiedError('parseFailure', message, failOptions),
      apiFailure: (message, failOptions) => classifiedError('apiFailure', message, failOptions)
    },
    format: {
      number(value) {
        return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value);
      },
      usd(value) {
        return `${new Intl.NumberFormat('es-ES', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(value)} US$`;
      }
    }
  };
  return { ctx, requests };
}

async function captureError(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected a classified plugin failure');
}

test('R21 declara autoridad minima para el bridge loopback con bearer del host', () => {
  const plugin = loadPlugin();
  const manifest = JSON.parse(JSON.stringify(plugin));

  assert.equal(manifest.id, 'token-monitor-bridge');
  assert.equal(manifest.name, 'Token Monitor');
  assert.equal(manifest.icon?.monogram, 'TM');
  assert.match(manifest.icon?.tint || '', /^#[0-9a-f]{6}$/i);
  assert.deepEqual(manifest.endpoints, [{
    setting: 'BASE_URL',
    policy: 'https-or-private-network-http'
  }]);
  assert.deepEqual(manifest.auth, { type: 'bearer', secret: 'SUMMARY_TOKEN' });
  assert.deepEqual(manifest.capabilities, ['http-status']);
  assert.deepEqual(
    manifest.settings.map(({ key, type }) => ({ key, type })),
    [
      { key: 'BASE_URL', type: 'plain' },
      { key: 'SUMMARY_TOKEN', type: 'secure' }
    ]
  );
  assert.equal(typeof plugin.fetchUsage, 'function');
});

test('R21 hace un unico GET exacto y devuelve solo Hoy, Este mes y Actualizado', async () => {
  const plugin = loadPlugin();
  const { ctx, requests } = contextFor({ status: 200, headers: {}, json: validPayload() });

  const snapshot = JSON.parse(JSON.stringify(await plugin.fetchUsage(ctx)));

  assert.deepEqual(requests, [{
    url: `http://127.0.0.1:17322${SUMMARY_PATH}`,
    options: { timeoutSeconds: 2 }
  }]);
  assert.deepEqual(Object.keys(snapshot), ['details'], 'summary must not masquerade as a quota or cost window');
  assert.ok(Array.isArray(snapshot.details));
  assert.equal(snapshot.details.length, 1);
  assert.equal(
    Object.hasOwn(snapshot.details[0], 'title'),
    false,
    'compact summary must not repeat the redundant Resumen de uso title'
  );
  const rows = snapshot.details.flatMap((section) => section.rows || []);
  assert.deepEqual(rows.map((row) => row.label), ['Hoy', 'Este mes', 'Actualizado']);

  const today = JSON.stringify(rows[0]);
  const month = JSON.stringify(rows[1]);
  const updated = JSON.stringify(rows[2]);
  assert.match(today, /1[.,]25|1[.,]245[.,]800/i);
  assert.match(today, /token/i);
  assert.match(today, /3[.,]41/);
  assert.match(month, /18[.,]4|18[.,]402[.,]110/i);
  assert.match(month, /token/i);
  assert.match(month, /42[.,]10|42[.,]1/);
  assert.match(updated, /2026-08-26/);
  assert.match(updated, /08:29/);
  assert.match(updated, /UTC/i, 'last-good must expose the absolute observedAt timestamp');
  assert.match(updated, /8\s*s|2\s*(?:fuente|source)/i);
  assert.equal(Object.hasOwn(snapshot, 'primary'), false);
  assert.equal(Object.hasOwn(snapshot, 'secondary'), false);
  assert.equal(Object.hasOwn(snapshot, 'cost'), false);
});

test('R21 omite coste desconocido en vez de inventar cero', async () => {
  const plugin = loadPlugin();
  const payload = validPayload();
  payload.periods.today.costUsd = null;
  payload.periods.month.costUsd = null;
  const { ctx } = contextFor({ status: 200, headers: {}, json: payload });

  const snapshot = JSON.parse(JSON.stringify(await plugin.fetchUsage(ctx)));
  const periodRows = snapshot.details.flatMap((section) => section.rows || []).slice(0, 2);

  for (const row of periodRows) {
    assert.match(JSON.stringify(row), /token/i);
    assert.doesNotMatch(JSON.stringify(row), /(?:US\$|USD|\$\s*0|0[.,]00)/i);
  }
});

test('R21 rechaza 401 y schema/rangos invalidos con errores tipados y acotados', async (t) => {
  const plugin = loadPlugin();
  const unauthorized = contextFor({
    status: 401,
    headers: {},
    json: { schemaVersion: 1, error: { code: 'unauthorized', detail: PRIVATE_MARKER } }
  });
  const authError = await captureError(() => plugin.fetchUsage(unauthorized.ctx));
  assert.equal(authError.code, 'authenticationExpired');
  assert.doesNotMatch(`${authError.message}\n${JSON.stringify(authError)}`, new RegExp(`${PRIVATE_MARKER}|${SECRET_MARKER}`));

  const mutations = [
    ['schemaVersion', (payload) => { payload.schemaVersion = 2; }],
    ['generatedAt', (payload) => { payload.generatedAt = 'not-a-date'; }],
    ['observedAt', (payload) => { payload.freshness.observedAt = 'not-a-date'; }],
    ['ageSeconds', (payload) => { payload.freshness.ageSeconds = -1; }],
    ['sourceCount', (payload) => { payload.freshness.sourceCount = 1.5; }],
    ['staleSourceCount', (payload) => { payload.freshness.staleSourceCount = 3; }],
    ['today.totalTokens', (payload) => { payload.periods.today.totalTokens = -1; }],
    ['month.totalTokens', (payload) => { payload.periods.month.totalTokens = Number.MAX_SAFE_INTEGER + 1; }],
    ['costUsd', (payload) => { payload.periods.today.costUsd = 0; }],
    ['period missing', (payload) => { delete payload.periods.month; }]
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const payload = validPayload();
      mutate(payload);
      payload.private = PRIVATE_MARKER;
      const { ctx } = contextFor({ status: 200, headers: {}, json: payload });
      const error = await captureError(() => plugin.fetchUsage(ctx));
      assert.equal(error.code, 'parseFailure');
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, new RegExp(`${PRIVATE_MARKER}|${SECRET_MARKER}`));
    });
  }
});

test('R21 permanece dentro del sandbox oficial sin cuotas, imports, Node ni timers', () => {
  const source = pluginSource();
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\b|\bBuffer\b|\bglobalThis\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/);
  assert.doesNotMatch(source, /\bset(?:Timeout|Interval)\s*\(|\bclear(?:Timeout|Interval)\s*\(/);
  assert.doesNotMatch(source, /\b(?:primary|secondary|tertiary|cost|usedPercent|remainingPercent)\s*:/);
  assert.doesNotMatch(source, /\bctx\.pct\s*\(/);
});
