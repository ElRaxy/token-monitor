'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
const paragraphs = readme.split(/\n\s*\n/).map((value) => value.toLowerCase());
const paragraphWith = (...terms) => paragraphs.some(
  (paragraph) => terms.every((term) => paragraph.includes(term.toLowerCase()))
);

test('R16 README acredita el fork CodexBar y delimita su distribución', () => {
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  require(
    /\[`?ElRaxy\/token-monitor`?\]\(https:\/\/github\.com\/ElRaxy\/token-monitor\)/.test(readme),
    'fork: ElRaxy/token-monitor'
  );
  require(
    paragraphWith('dashboard-v1', 'independent', 'not merged'),
    'architecture: independent dashboard-v1 integration, not a repository merge'
  );
  require(
    paragraphWith('loopback', 'fails closed', 'duplicate native probes'),
    'security: loopback, fail closed, and no duplicate native probes'
  );
  for (const account of ['Javis603', 'steipete', 'ElRaxy']) {
    require(
      paragraphWith('credits', `https://github.com/${account}`),
      `credits: ${account}`
    );
  }
  require(/\]\(LICENSE\)/.test(readme), 'license: local Token Monitor LICENSE');
  require(
    readme.includes('https://github.com/steipete/CodexBar/blob/main/LICENSE'),
    'license: direct CodexBar LICENSE link'
  );
  require(
    paragraphWith('credits', 'mit license', 'no upstream affiliation', 'endorsement'),
    'license: MIT terms and no upstream affiliation or endorsement'
  );
  require(
    paragraphWith(
      'upstream releases',
      "do not include this fork's CodexBar integration",
      'does not currently publish fork-specific binaries'
    ),
    'distribution: upstream releases exclude the integration and the fork has no binaries'
  );

  assert.deepEqual(missing, [], `missing CodexBar fork README facts:\n- ${missing.join('\n- ')}`);
});
