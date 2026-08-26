'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const PLUGIN_PATH = path.join(ROOT, 'integrations/codexbar/token-monitor.js');

function loadPlugin() {
  assert.ok(fs.existsSync(PLUGIN_PATH), 'F6 requires the real CodexBar plugin');
  let definition = null;
  vm.runInNewContext(fs.readFileSync(PLUGIN_PATH, 'utf8'), {
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

function codexBarContext(payload) {
  return {
    settings: {
      get(key) {
        assert.equal(key, 'BASE_URL');
        return 'http://127.0.0.1:17322';
      }
    },
    http: {
      async getJSON() {
        return { status: 200, headers: {}, json: payload };
      }
    },
    format: {
      number(value, options) {
        return new Intl.NumberFormat('en-US', options).format(value);
      },
      usd(value) {
        return `$${Number(value).toFixed(2)}`;
      }
    }
  };
}

async function snapshotFor(plugin, payload = validPayload()) {
  const snapshot = await plugin.fetchUsage(codexBarContext(payload));
  return JSON.parse(JSON.stringify(snapshot));
}

test('R24 presenta exactamente tres filas localizadas sin titulo ni cuotas', async () => {
  const snapshot = await snapshotFor(loadPlugin());

  assert.deepEqual(snapshot, {
    details: [{
      rows: [
        { label: 'Hoy', value: '1,25 M tokens', secondaryValue: '3,41 US$' },
        { label: 'Este mes', value: '18,4 M tokens', secondaryValue: '42,10 US$' },
        {
          label: 'Actualizado',
          value: 'hace 8 s',
          secondaryValue: '26/08 · 08:29 UTC · 2 fuentes'
        }
      ]
    }]
  });
});

test('R24 mantiene unidades canonicas y representaciones acotadas en los limites validos', async () => {
  const plugin = loadPlugin();
  const cases = [
    [999, '999 tokens'],
    [1_000, '1 k tokens'],
    [999_949, '999,9 k tokens'],
    [999_999, '1 M tokens'],
    [1_000_000, '1 M tokens'],
    [Number.MAX_SAFE_INTEGER, '9.007.199.254,74 M tokens']
  ];

  for (const [totalTokens, expected] of cases) {
    const payload = validPayload();
    payload.periods.today.totalTokens = totalTokens;
    assert.equal((await snapshotFor(plugin, payload)).details[0].rows[0].value, expected);
  }

  const payload = validPayload();
  payload.periods.today.costUsd = Number.MAX_VALUE;
  assert.equal(
    (await snapshotFor(plugin, payload)).details[0].rows[0].secondaryValue,
    '1,80e+308 US$'
  );
});

test('R25 conserva las fuentes stale como un hecho secundario compacto', async () => {
  const plugin = loadPlugin();
  const payload = validPayload();
  payload.freshness.staleSourceCount = 1;

  const snapshot = await snapshotFor(plugin, payload);
  const updated = snapshot.details[0].rows[2];

  assert.deepEqual(updated, {
    label: 'Actualizado',
    value: 'hace 8 s',
    secondaryValue: '26/08 · 08:29 UTC · 2 fuentes · 1 stale'
  });
});

test('R26 usa un verde sobrio para el badge solido del host', () => {
  const manifest = JSON.parse(JSON.stringify(loadPlugin()));

  assert.deepEqual(manifest.icon, { monogram: 'TM', tint: '#167A3E' });
});
