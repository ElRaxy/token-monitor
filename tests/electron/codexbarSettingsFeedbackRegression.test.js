'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/i18n.js'), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

test('CodexBar settings expose accessible, bounded save feedback', () => {
  for (const id of ['codexbarDashboardFeedback', 'codexbarDashboardStatus']) {
    const tag = html.match(new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`))?.[0];
    assert.ok(tag, `${id} must exist`);
    assert.match(tag, /\baria-live=(["'])(?:polite|assertive)\1/);
  }

  const feedback = functionBody(app, 'setCodexBarFeedback');
  assert.match(feedback, /\.(?:slice|substring)\(\s*0\s*,\s*(?:\d+|[A-Z][A-Z0-9_]*)\s*\)/);

  const save = functionBody(app, 'saveCodexBarSettings');
  const failed = save.match(/catch\s*\(\s*error\s*\)\s*\{([\s\S]*?)\}\s*finally/)?.[1];
  assert.ok(failed, 'saveCodexBarSettings must catch before finally');
  assert.match(failed, /setCodexBarFeedback\s*\(/);
  assert.match(failed, /t\s*\(\s*["']settings\.codexbar\.saveError["']/);
  assert.match(failed, /\bthrow\s+error\b/);
  assert.doesNotMatch(failed, /error\s*(?:\?\.|\.)|String\s*\(\s*error\s*\)|\$\{\s*error\b|setCodexBarFeedback\s*\(\s*error\b/);
  assert.match(save, /finally\s*\{[\s\S]*codexbarDashboardTokenInput\.value\s*=\s*["']["']/);
});

test('CodexBar dashboard status is redacted and rendered with provenance', () => {
  const status = functionBody(main, 'codexbarDashboardStatus');
  assert.match(status, /deviceRuntimeHandle[\s\S]*getDiagnostics\s*\(/);
  assert.match(status, /deviceRuntimeHandle[\s\S]*getSnapshot\s*\(/);
  assert.match(status, /\.filter\s*\([\s\S]{0,300}producer[\s\S]{0,300}codexbar/);
  for (const field of ['connectedAt', 'producerVersion', 'generatedAt', 'staleAfterMs', 'diagnostics']) {
    assert.match(status, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(status, /token/i);

  const rendererSettings = functionBody(main, 'settingsForRenderer');
  assert.match(rendererSettings, /\bcodexbarDashboardStatus\s*[:,]/);
  const rendered = functionBody(app, 'syncCodexBarDashboardStatus');
  for (const field of ['connectedAt', 'producerVersion', 'generatedAt', 'diagnostics']) {
    assert.match(rendered, new RegExp(`\\b${field}\\b`));
  }
  assert.match(rendered, /\bage\b|formatUpdatedAge/);
});

test('CodexBar feedback and status copy covers every locale', () => {
  const keys = ['saved', 'saveError', 'statusDisabled', 'statusConfigured', 'statusConnecting',
    'statusActive', 'statusDegraded', 'statusError', 'statusVersion', 'statusGenerated', 'statusDiagnostics'];
  for (const suffix of keys) {
    const key = `settings.codexbar.${suffix}`;
    assert.equal(i18n.split(`'${key}'`).length - 1, 5, `${key} must appear once in each locale`);
  }
});
