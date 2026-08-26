'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CREDENTIAL_SETTING_PATHS,
  CredentialStore,
  credentialSettingsForRenderer,
  stripCredentialSettings
} = require('../../src/shared/credentialStore');

test('R20 stores the summary bearer separately and redacts it from settings and renderer', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codexbar-summary-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new CredentialStore(dataDir);
  const settings = {
    codexbarDashboardToken: 'dashboard-direction-secret',
    codexbarSummaryToken: 'summary-direction-secret',
    codexbarSummaryEnabled: true
  };

  assert.deepEqual(CREDENTIAL_SETTING_PATHS.codexbarDashboardToken, [
    'integrations', 'codexbar', 'dashboardToken'
  ]);
  assert.deepEqual(CREDENTIAL_SETTING_PATHS.codexbarSummaryToken, [
    'integrations', 'codexbar', 'summaryToken'
  ]);
  assert.notDeepEqual(
    CREDENTIAL_SETTING_PATHS.codexbarSummaryToken,
    CREDENTIAL_SETTING_PATHS.codexbarDashboardToken
  );

  store.replaceSettingsCredentials(settings);
  const stored = store.settingsCredentials();
  assert.equal(stored.codexbarDashboardToken, 'dashboard-direction-secret');
  assert.equal(stored.codexbarSummaryToken, 'summary-direction-secret');

  const privateDocument = fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8');
  assert.match(privateDocument, /summary-direction-secret/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dataDir, 'credentials.json')).mode & 0o777, 0o600);
  }

  const persistedSettings = stripCredentialSettings(settings);
  assert.deepEqual(persistedSettings, { codexbarSummaryEnabled: true });
  assert.doesNotMatch(JSON.stringify(persistedSettings), /direction-secret/);

  const rendererCredentials = credentialSettingsForRenderer(stored);
  assert.equal(rendererCredentials.codexbarDashboardToken, '');
  assert.equal(rendererCredentials.codexbarSummaryToken, '');
});
