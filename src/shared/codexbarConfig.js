'use strict';

const { normalizeCodexBarDashboardUrl } = require('./codexbarDashboard');

const DEFAULT_CODEXBAR_DASHBOARD_URL = 'http://127.0.0.1:8080';
const MAX_BEARER_LENGTH = 4096;
const CODEXBAR_DASHBOARD_PROVIDER_IDS = Object.freeze([
  'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'kimi', 'grok',
  'copilot', 'commandcode', 'mimo', 'zai', 'kiro', 'qoder', 'deepseek',
  'openrouter', 'minimax', 'volcengine', 'ollama'
]);
const VALID_PROVIDERS = new Set(CODEXBAR_DASHBOARD_PROVIDER_IDS);
const CONFIG_ERROR_CODES = new Set([
  'invalid-config',
  'invalid-token',
  'missing-providers',
  'missing-token',
  'unknown-provider',
  'unsafe-url'
]);

class CodexBarConfigError extends Error {
  constructor(code) {
    const safeCode = CONFIG_ERROR_CODES.has(code) ? code : 'invalid-config';
    super(`CodexBar configuration ${safeCode}`);
    this.name = 'CodexBarConfigError';
    this.code = safeCode;
  }
}

function normalizeUrl(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new CodexBarConfigError('unsafe-url');
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  try {
    return normalizeCodexBarDashboardUrl(raw || DEFAULT_CODEXBAR_DASHBOARD_URL);
  } catch (_) {
    throw new CodexBarConfigError('unsafe-url');
  }
}

function normalizeToken(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new CodexBarConfigError('invalid-token');
  const token = value.trim();
  if (token.length > MAX_BEARER_LENGTH || /[\u0000-\u0020\u007f-\u009f]/.test(token)) {
    throw new CodexBarConfigError('invalid-token');
  }
  return token;
}

function normalizeProviders(value) {
  if (value === undefined || value === null || value === '') return [];
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : null);
  if (!source) throw new CodexBarConfigError('unknown-provider');

  const providers = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== 'string') throw new CodexBarConfigError('unknown-provider');
    const provider = item.trim().toLowerCase();
    if (!provider) continue;
    if (!VALID_PROVIDERS.has(provider)) throw new CodexBarConfigError('unknown-provider');
    if (seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeCodexBarConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CodexBarConfigError('invalid-config');
  }
  if (
    Object.hasOwn(input, 'codexbarDashboardEnabled')
    && input.codexbarDashboardEnabled !== undefined
    && input.codexbarDashboardEnabled !== null
    && typeof input.codexbarDashboardEnabled !== 'boolean'
  ) {
    throw new CodexBarConfigError('invalid-config');
  }
  const config = input;
  const normalized = {
    codexbarDashboardEnabled: config.codexbarDashboardEnabled === true,
    codexbarDashboardUrl: normalizeUrl(config.codexbarDashboardUrl),
    codexbarDashboardToken: normalizeToken(config.codexbarDashboardToken),
    codexbarDelegatedProviders: normalizeProviders(config.codexbarDelegatedProviders)
  };

  if (normalized.codexbarDashboardEnabled && !normalized.codexbarDashboardToken) {
    throw new CodexBarConfigError('missing-token');
  }
  if (normalized.codexbarDashboardEnabled && normalized.codexbarDelegatedProviders.length === 0) {
    throw new CodexBarConfigError('missing-providers');
  }
  return normalized;
}

module.exports = {
  CODEXBAR_DASHBOARD_PROVIDER_IDS,
  DEFAULT_CODEXBAR_DASHBOARD_URL,
  CodexBarConfigError,
  normalizeCodexBarConfig
};
