'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function readRequired(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  assert.ok(fs.existsSync(absolutePath), `R22 requires ${relativePath}`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function paragraphs(text) {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.toLowerCase());
}

function paragraphWith(text, ...terms) {
  return paragraphs(text).some(
    (paragraph) => terms.every((term) => (
      term instanceof RegExp ? term.test(paragraph) : paragraph.includes(String(term).toLowerCase())
    ))
  );
}

test('R22 README abre con identidad propia, captura y arquitectura bidireccional', () => {
  const readme = readRequired('README.md');
  const opening = readme.split('\n').slice(0, 90).join('\n');
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  require(/Token Monitor\s*(?:×|x)\s*CodexBar/i.test(opening), 'portada Token Monitor × CodexBar');
  require(
    /!\[[^\]]*(?:Token Monitor|CodexBar)[^\]]*\]\([^)]*codexbar[^)]*\.(?:png|webp|jpg)\)/i.test(opening),
    'captura real de la tarjeta CodexBar'
  );
  require(
    /\[ElRaxy\/token-monitor\]\(https:\/\/github\.com\/ElRaxy\/token-monitor\)/.test(readme),
    'enlace al fork publico'
  );
  require(
    paragraphWith(readme, 'dashboard-v1', 'codexbar', 'token monitor', /l[ií]mite|cuota/),
    'direccion CodexBar -> Token Monitor para limites'
  );
  require(
    paragraphWith(readme, 'token monitor', 'codexbar', 'plugin', 'resumen'),
    'direccion Token Monitor -> CodexBar para resumen de uso'
  );
  require(
    paragraphWith(readme, 'independ', 'dos', /direcci[oó]n|flujo|integraci[oó]n/),
    'flujos independientes sin ciclo semantico'
  );

  assert.deepEqual(missing, [], `missing fork README surface:\n- ${missing.join('\n- ')}`);
});

test('R22 README y guia instalan el provider comunitario sobre la API oficial de CodexBar 0.55.1', () => {
  const readme = readRequired('README.md');
  const guide = readRequired('docs/codexbar-plugin.md');
  const combined = `${readme}\n${guide}`;
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  require(/CodexBar[^\n]{0,80}0\.55\.1|0\.55\.1[^\n]{0,80}CodexBar/i.test(combined), 'version minima CodexBar 0.55.1');
  require(combined.includes('integrations/codexbar/token-monitor.js'), 'ruta del plugin versionado');
  require(combined.includes('~/.config/codexbar/providers/'), 'carpeta local de providers');
  require(/Settings\s*(?:→|>|\/).*Plugins|Ajustes\s*(?:→|>|\/).*Plugins/i.test(combined), 'instalacion por Settings -> Plugins');
  require(/BASE_URL/.test(combined), 'setting BASE_URL');
  require(/SUMMARY_TOKEN/.test(combined), 'setting secure SUMMARY_TOKEN');
  require(combined.includes('http://127.0.0.1:17322'), 'BASE_URL loopback por defecto');
  require(combined.includes('/api/integrations/codexbar/v1/summary'), 'ruta HTTP exacta del resumen');
  require(/Bearer/i.test(guide), 'autenticacion bearer del host');
  require(/timeout[^\n]*2\s*(?:s|seg)|2\s*(?:s|seg)[^\n]*timeout/i.test(guide), 'timeout fisico de 2 s');
  require(/Hoy/.test(guide) && /Este mes/.test(guide) && /Actualizado/.test(guide), 'tres filas nativas y nada mas');
  require(/sin (?:barras|porcentajes)|no (?:usa|muestra|dibuja) (?:barras|porcentajes)/i.test(guide), 'sin cuotas ni porcentajes falsos');

  assert.deepEqual(missing, [], `missing plugin setup documentation:\n- ${missing.join('\n- ')}`);
});

test('R22 documenta secretos separados, last-good factual y troubleshooting acotado', () => {
  const guide = readRequired('docs/codexbar-plugin.md');
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  require(paragraphWith(guide, 'summary_token', 'secure', 'codexbar'), 'SUMMARY_TOKEN es secure en CodexBar');
  require(
    paragraphWith(guide, 'summary_token', /distint|separad/, /hub|dashboard-v1/),
    'bearer dedicado distinto de Hub y dashboard-v1'
  );
  require(paragraphWith(guide, '127.0.0.1', 'solo', /local|loopback/), 'bind loopback-only');
  require(paragraphWith(guide, 'cache', /collector|probe/, /no|cero|sin/), 'lectura cache-only sin collectors ni probes');
  require(
    paragraphWith(guide, 'last-good', /absolut|utc|observedat|marca/, /fresc|actualiz/),
    'marca absoluta de frescura para el snapshot last-good'
  );
  for (const code of ['401', '404', '503']) require(new RegExp(`\\b${code}\\b`).test(guide), `troubleshooting HTTP ${code}`);
  require(/no-store/i.test(guide), 'Cache-Control no-store');
  require(/no[^\n]*(?:body|cuerpo)[^\n]*(?:secreto|token)|(?:secreto|token)[^\n]*no[^\n]*(?:log|error)/i.test(guide), 'errores sin secretos ni body remoto');

  assert.deepEqual(missing, [], `missing security/troubleshooting documentation:\n- ${missing.join('\n- ')}`);
});

test('R22 acredita autores y licencias sin fingir afiliacion ni release oficial', () => {
  const readme = readRequired('README.md');
  const missing = [];
  const require = (condition, description) => {
    if (!condition) missing.push(description);
  };

  for (const [project, account] of [
    ['Token Monitor', 'Javis603'],
    ['CodexBar', 'steipete']
  ]) {
    require(readme.includes(`https://github.com/${account}`), `autor de ${project}: ${account}`);
  }
  require(readme.includes('https://github.com/Javis603/token-monitor'), 'upstream Token Monitor');
  require(readme.includes('https://github.com/steipete/CodexBar'), 'upstream CodexBar');
  require(/\]\(LICENSE\)/.test(readme), 'licencia local Token Monitor');
  require(
    readme.includes('https://github.com/steipete/CodexBar/blob/main/LICENSE'),
    'licencia de CodexBar'
  );
  require(paragraphWith(readme, /no (?:est[aá] |hay )?(?:afiliaci[oó]n|aval|endorsement)/), 'sin afiliacion ni endorsement');
  require(
    paragraphWith(readme, /release|versi[oó]n|publicaci[oó]n/, /independ|separad/, /oficial|upstream/),
    'releases del fork separadas de las oficiales'
  );
  require(readme.includes('https://github.com/ElRaxy/token-monitor/releases'), 'releases del fork');
  require(readme.includes('https://github.com/Javis603/token-monitor/releases'), 'releases oficiales Token Monitor');
  require(readme.includes('https://github.com/steipete/CodexBar/releases'), 'releases oficiales CodexBar');

  assert.deepEqual(missing, [], `missing authorship/release boundaries:\n- ${missing.join('\n- ')}`);
});
