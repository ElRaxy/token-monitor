'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '../../integrations/codexbar/token-monitor.js');

function loadPlugin() {
  let definition;
  vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8'), {
    defineProvider(value) { definition = value; }
  });
  return definition;
}

test('R21 refuses every non-exact loopback BASE_URL before bearer HTTP', async () => {
  const plugin = loadPlugin();
  const rejectedBaseUrls = [
    'http://192.168.1.50:17322',
    'http://127.0.0.1.evil.test:17322',
    'http://127.0.0.1:17322@evil.test',
    'https://127.0.0.1:17322',
    'http://127.0.0.1:17323'
  ];

  for (const baseUrl of rejectedBaseUrls) {
    let requestCount = 0;
    const ctx = {
      settings: { get: () => baseUrl },
      http: {
        getJSON: async () => {
          requestCount += 1;
          return { status: 200, headers: {}, json: {} };
        }
      },
      fail: {
        providerUnavailable: (message) => Object.assign(new Error(message), {
          code: 'providerUnavailable'
        }),
        parseFailure: (message) => Object.assign(new Error(message), { code: 'parseFailure' }),
        authenticationExpired: (message) => new Error(message),
        permissionDenied: (message) => new Error(message),
        apiFailure: (message) => new Error(message)
      }
    };

    await assert.rejects(
      plugin.fetchUsage(ctx),
      (error) => error?.code === 'providerUnavailable' && /loopback/i.test(error.message)
    );
    assert.equal(requestCount, 0, `must not send bearer traffic to ${baseUrl}`);
  }
});
