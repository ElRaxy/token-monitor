'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

test('preload exposes tokenMonitor when its sandbox only allows electron', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/electron/preload.js'), 'utf8');
  const settings = { codexbarDashboardProviderIds: ['codex'] };
  const invokedChannels = [];
  let exposed;
  const ipcRenderer = {
    invoke(channel) {
      invokedChannels.push(channel);
      return Promise.resolve(settings);
    },
    on() {},
    removeListener() {},
    send() {}
  };

  assert.doesNotThrow(() => vm.runInNewContext(source, {
    require(specifier) {
      if (specifier !== 'electron') {
        throw new Error(`preload sandbox blocked require: ${specifier}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            if (name === 'tokenMonitor') exposed = api;
          }
        },
        ipcRenderer
      };
    }
  }, { filename: 'src/electron/preload.js' }));

  assert.ok(exposed, 'preload must expose the tokenMonitor API');
  assert.strictEqual(await exposed.getSettings(), settings);
  assert.deepEqual(invokedChannels, ['settings:get']);
});
