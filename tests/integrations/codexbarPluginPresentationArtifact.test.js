'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('R26 records the reproducible CodexBar 0.55.1 presentation gate', () => {
  const evidencePath = path.join(root, '.github/assets/codexbar-token-monitor-card-f6.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.codexbarVersion, '0.55.1');
  assert.equal(evidence.codexbarBuild, 130);

  const pluginBytes = fs.readFileSync(path.join(root, 'integrations/codexbar/token-monitor.js'));
  assert.equal(evidence.pluginSha256, sha256(pluginBytes));
  assert.equal(evidence.installedCopyMatches, true);
  assert.equal(evidence.processCount, 1);

  const expectedCapture = '.github/assets/codexbar-token-monitor-card.png';
  assert.equal(evidence.capture, expectedCapture);

  const screenshotBytes = fs.readFileSync(path.join(root, expectedCapture));
  assert.deepEqual(
    [...screenshotBytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );

  const screenshotWidth = screenshotBytes.readUInt32BE(16);
  const screenshotHeight = screenshotBytes.readUInt32BE(20);
  assert.equal(evidence.screenshotSha256, sha256(screenshotBytes));
  assert.equal(evidence.screenshotWidth, screenshotWidth);
  assert.equal(evidence.screenshotHeight, screenshotHeight);
  assert.ok(screenshotWidth >= 580, 'the captured native card must remain readable');
  assert.ok(screenshotHeight >= 320, 'the complete three-row card must remain visible');

  assert.equal(evidence.decision, 'swift-renderer-required');
});
