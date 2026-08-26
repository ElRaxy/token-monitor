'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('R23 ships a public-safe native CodexBar card screenshot', () => {
  const screenshotPath = path.join(root, '.github/assets/codexbar-token-monitor-card.png');
  const bytes = fs.readFileSync(screenshotPath);

  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.length > 10_000, 'the screenshot must be a real rendered asset, not a placeholder');
  assert.ok(bytes.readUInt32BE(16) >= 580, 'the native card must remain readable');
  assert.ok(bytes.readUInt32BE(20) >= 320, 'the complete three-row card must remain visible');

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /public-safe sample data/i);
});

test('R23 records the reproducible CodexBar 0.55.1 runtime gate', () => {
  const guide = fs.readFileSync(path.join(root, 'docs/codexbar-plugin.md'), 'utf8');

  assert.match(guide, /CodexBar 0\.55\.1/);
  assert.match(guide, /QuickJS/);
  assert.match(guide, /JavaScriptCore/);
  assert.match(guide, /codexbar plugins fetch token-monitor-bridge --json --pretty/);
  assert.match(guide, /aprobaci[oó]n tipada/i);
  assert.match(guide, /Cache-Control:\s*no-store/i);
  assert.match(guide, /sin CORS/i);
});
