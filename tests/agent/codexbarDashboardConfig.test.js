'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const AGENT_PATH = path.join(__dirname, '..', '..', 'src', 'agent', 'agent.js');

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected invalid agent configuration to throw');
}

test('R13 agente construye config CodexBar sin imprimir el bearer', () => {
  const source = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.match(
    source,
    /if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{/,
    'agent.js must be importable without starting the runtime'
  );

  const output = [];
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  console.error = (...parts) => output.push(parts.join(' '));
  console.log = (...parts) => output.push(parts.join(' '));
  console.warn = (...parts) => output.push(parts.join(' '));

  try {
    const { buildAgentConfiguration } = require(AGENT_PATH);
    assert.equal(typeof buildAgentConfiguration, 'function');

    const disabled = buildAgentConfiguration({ env: {}, argv: [] });
    assert.deepEqual({
      codexbarDashboardEnabled: disabled.limitsOptions.codexbarDashboardEnabled,
      codexbarDashboardUrl: disabled.limitsOptions.codexbarDashboardUrl,
      codexbarDashboardToken: disabled.limitsOptions.codexbarDashboardToken,
      codexbarDelegatedProviders: disabled.limitsOptions.codexbarDelegatedProviders
    }, {
      codexbarDashboardEnabled: false,
      codexbarDashboardUrl: 'http://127.0.0.1:8080',
      codexbarDashboardToken: '',
      codexbarDelegatedProviders: []
    });

    const secret = 'agent-private-bearer-marker';
    const configured = buildAgentConfiguration({
      env: {
        TOKEN_MONITOR_CODEXBAR_URL: 'http://localhost:9090/',
        TOKEN_MONITOR_CODEXBAR_TOKEN: `  ${secret}  `,
        TOKEN_MONITOR_CODEXBAR_PROVIDERS: 'codex,claude,codex'
      },
      argv: []
    });
    assert.deepEqual({
      codexbarDashboardEnabled: configured.limitsOptions.codexbarDashboardEnabled,
      codexbarDashboardUrl: configured.limitsOptions.codexbarDashboardUrl,
      codexbarDashboardToken: configured.limitsOptions.codexbarDashboardToken,
      codexbarDelegatedProviders: configured.limitsOptions.codexbarDelegatedProviders
    }, {
      codexbarDashboardEnabled: true,
      codexbarDashboardUrl: 'http://localhost:9090',
      codexbarDashboardToken: secret,
      codexbarDelegatedProviders: ['codex', 'claude']
    });

    const argvSecret = 'argv-private-bearer-marker';
    const argvOnly = buildAgentConfiguration({
      env: {},
      argv: [
        '--codexbar-url=http://localhost:9191',
        `--codexbar-token=${argvSecret}`,
        '--codexbar-providers=claude'
      ]
    });
    assert.equal(argvOnly.limitsOptions.codexbarDashboardEnabled, false);
    assert.equal(argvOnly.limitsOptions.codexbarDashboardToken, '');

    const partial = captureError(() => buildAgentConfiguration({
      env: { TOKEN_MONITOR_CODEXBAR_TOKEN: secret },
      argv: []
    }));
    assert.equal(partial?.name, 'CodexBarConfigError');
    assert.equal(partial?.code, 'missing-providers');
    assert.doesNotMatch(`${partial?.message}\n${JSON.stringify(partial)}`, /agent-private-bearer-marker/);
    assert.doesNotMatch(output.join('\n'), /agent-private-bearer-marker|argv-private-bearer-marker/);
  } finally {
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});
