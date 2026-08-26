'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentConfiguration } = require('../../src/agent/agent');

test('empty CodexBar variables copied from .env.example keep the agent disabled', () => {
  const configuration = buildAgentConfiguration({
    env: {
      TOKEN_MONITOR_CODEXBAR_URL: '',
      TOKEN_MONITOR_CODEXBAR_TOKEN: '',
      TOKEN_MONITOR_CODEXBAR_PROVIDERS: ''
    },
    argv: []
  });
  assert.equal(configuration.limitsOptions.codexbarDashboardEnabled, false);
});
