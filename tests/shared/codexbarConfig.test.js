'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function configApi() {
  let api;
  assert.doesNotThrow(() => {
    api = require('../../src/shared/codexbarConfig');
  }, 'src/shared/codexbarConfig.js should expose the shared security boundary');
  return api;
}

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected a typed CodexBar configuration error');
}

function assertSafeConfigError(error, expectedCode, forbidden = []) {
  assert.equal(error?.name, 'CodexBarConfigError');
  assert.equal(error?.code, expectedCode);
  const publicText = `${error?.message || ''}\n${JSON.stringify(error)}`;
  for (const value of forbidden) assert.doesNotMatch(publicText, new RegExp(value, 'i'));
}

test('CodexBar config defaults to a disabled loopback integration', () => {
  const {
    DEFAULT_CODEXBAR_DASHBOARD_URL,
    normalizeCodexBarConfig
  } = configApi();

  assert.equal(DEFAULT_CODEXBAR_DASHBOARD_URL, 'http://127.0.0.1:8080');
  assert.deepEqual(normalizeCodexBarConfig(), {
    codexbarDashboardEnabled: false,
    codexbarDashboardUrl: DEFAULT_CODEXBAR_DASHBOARD_URL,
    codexbarDashboardToken: '',
    codexbarDelegatedProviders: []
  });
});

test('CodexBar config canonicalizes CSV and array provider selections', () => {
  const { normalizeCodexBarConfig } = configApi();
  const base = {
    codexbarDashboardEnabled: true,
    codexbarDashboardUrl: 'http://localhost:9090/',
    codexbarDashboardToken: '  dashboard-bearer  '
  };

  assert.deepEqual(normalizeCodexBarConfig({
    ...base,
    codexbarDelegatedProviders: 'claude, codex, claude'
  }), {
    codexbarDashboardEnabled: true,
    codexbarDashboardUrl: 'http://localhost:9090',
    codexbarDashboardToken: 'dashboard-bearer',
    codexbarDelegatedProviders: ['claude', 'codex']
  });
  assert.deepEqual(normalizeCodexBarConfig({
    ...base,
    codexbarDelegatedProviders: ['codex', ' claude ', 'codex']
  }).codexbarDelegatedProviders, ['codex', 'claude']);
});

test('CodexBar config rejects non-loopback URLs without echoing input', () => {
  const { normalizeCodexBarConfig } = configApi();
  const error = captureError(() => normalizeCodexBarConfig({
    codexbarDashboardUrl: 'http://private-config-marker.example/secret-path'
  }));

  assertSafeConfigError(error, 'unsafe-url', [
    'private-config-marker',
    'secret-path'
  ]);
});

test('CodexBar config rejects unknown providers and the incoming-only doubao alias', () => {
  const { normalizeCodexBarConfig } = configApi();
  for (const provider of ['private-provider-marker', 'doubao']) {
    const error = captureError(() => normalizeCodexBarConfig({
      codexbarDelegatedProviders: ['claude', provider]
    }));
    assertSafeConfigError(error, 'unknown-provider', [provider]);
  }
});

test('enabled CodexBar config requires a safe bearer and at least one provider', () => {
  const { normalizeCodexBarConfig } = configApi();
  const secret = 'private-bearer-marker';

  const missingToken = captureError(() => normalizeCodexBarConfig({
    codexbarDashboardEnabled: true,
    codexbarDelegatedProviders: ['claude']
  }));
  assertSafeConfigError(missingToken, 'missing-token');

  const missingProviders = captureError(() => normalizeCodexBarConfig({
    codexbarDashboardEnabled: true,
    codexbarDashboardToken: secret
  }));
  assertSafeConfigError(missingProviders, 'missing-providers', [secret]);

  const unsafeToken = captureError(() => normalizeCodexBarConfig({
    codexbarDashboardEnabled: true,
    codexbarDashboardToken: `${secret}\nsecond-line`,
    codexbarDelegatedProviders: ['claude']
  }));
  assertSafeConfigError(unsafeToken, 'invalid-token', [secret, 'second-line']);
});
