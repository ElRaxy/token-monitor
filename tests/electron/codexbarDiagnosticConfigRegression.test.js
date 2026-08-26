'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('diagnostic snapshot resolves the private CodexBar token in main', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const start = source.indexOf('getConfiguration: () => diagnosticConfigurationFromSettings');
  const end = source.indexOf('syncUploadIntervalMs: syncUploadIntervalMs()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const configuration = source.slice(start, end);
  assert.match(configuration, /limits:\s*\{[\s\S]*codexbarDashboardToken:\s*settings\?\.codexbarDashboardToken/);
});
