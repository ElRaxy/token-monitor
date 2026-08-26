'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
const paragraphs = (text) => text.split(/\n\s*\n/).map((value) => value.toLowerCase());
const paragraphWith = (text, terms) => paragraphs(text).some(
  (paragraph) => terms.every((term) => paragraph.includes(term))
);

test('R15 docs describen contrato ownership y setup seguro', () => {
  const env = read('.env.example');
  const configuration = read('docs/configuration.md');
  const api = read('docs/API.md');
  const exactVariables = [
    'TOKEN_MONITOR_CODEXBAR_URL',
    'TOKEN_MONITOR_CODEXBAR_TOKEN',
    'TOKEN_MONITOR_CODEXBAR_PROVIDERS'
  ];
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  for (const variable of exactVariables) {
    require(new RegExp(`^${variable}=`, 'm').test(env), `.env.example: ${variable}`);
    require(configuration.includes(variable), `configuration: ${variable}`);
  }
  require(/opt[- ]?in|disabled by default/i.test(configuration), 'configuration: opt-in/default off');
  require(
    /http:\/\/(?:127\.0\.0\.1|localhost)/i.test(env)
      && /loopback|localhost/i.test(configuration)
      && /http:\/\/(?:127\.0\.0\.1|localhost)/i.test(configuration),
    'configuration: HTTP loopback only'
  );
  require(/Authorization\s*:\s*Bearer/i.test(configuration), 'configuration: bearer header');
  require(paragraphWith(configuration, ['identity', 'redacted']), 'configuration: identity redacted');
  require(
    paragraphWith(configuration, ['codexbar', 'owner', 'native', 'probe'])
      || /owned by CodexBar[^.\n]*(?:not|never)[^.\n]*(?:native|probe)/i.test(configuration),
    'configuration: one owner and no native probe'
  );
  require(
    paragraphs(configuration).some((paragraph) => (
      paragraph.includes('codexbar')
      && (paragraph.includes('does not') || paragraph.includes('never'))
      && paragraph.includes('usage')
      && paragraph.includes('cost')
      && paragraph.includes('session')
    )),
    'configuration: no CodexBar usage, costs, or sessions'
  );
  require(
    paragraphs(configuration).some((paragraph) => (
      paragraph.includes('codexbar dashboard')
      && paragraph.includes('diagnostic')
      && (paragraph.includes('not a poller') || paragraph.includes('never use') || paragraph.includes('must not'))
    )),
    'configuration: one-shot dashboard is diagnostic, not a poller'
  );
  for (const field of [
    'producer',
    'producerVersion',
    'producedAt',
    'staleAfterMs',
    'sourceDeviceId',
    'limitsOnly'
  ]) require(api.includes(field), `API: ${field}`);
  require(/additive/i.test(api), 'API: additive compatibility');

  assert.deepEqual(missing, [], `missing CodexBar documentation:\n- ${missing.join('\n- ')}`);
});
