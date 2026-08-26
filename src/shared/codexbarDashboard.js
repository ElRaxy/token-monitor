'use strict';

const { LIMIT_PROVIDER_IDS } = require('./limitProviders');
const { DEFAULT_LIMITS_REFRESH_MS, normalizeLimitsSummary } = require('./limits');

const DASHBOARD_PATH = '/dashboard/v1/snapshot';
const DASHBOARD_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const VALID_PROVIDERS = new Set(LIMIT_PROVIDER_IDS);
const PROVIDER_ALIASES = new Map([['doubao', 'volcengine']]);

class CodexBarDashboardError extends Error {
  constructor(code, options = {}) {
    super(`CodexBar dashboard ${String(code || 'error')}`);
    this.name = 'CodexBarDashboardError';
    this.code = String(code || 'error');
    this.httpStatus = finiteNumber(options.httpStatus);
    this.schemaVersion = finiteNumber(options.schemaVersion);
    this.providerId = safeProviderId(options.providerId);
    this.observedAt = observedAt(options.nowMs);
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function observedAt(nowMs) {
  const value = finiteNumber(nowMs) ?? Date.now();
  return new Date(value).toISOString();
}

function safeProviderId(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw && /^[a-z0-9._-]{1,64}$/.test(raw) ? raw : null;
}

function diagnostic(code, { schemaVersion = null, providerId = null, nowMs } = {}) {
  return {
    code,
    httpStatus: null,
    schemaVersion: finiteNumber(schemaVersion),
    providerId: safeProviderId(providerId),
    observedAt: observedAt(nowMs)
  };
}

function dashboardError(code, options = {}) {
  return new CodexBarDashboardError(code, options);
}

function isIpv4Loopback(hostname) {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  return octets[0] === 127 && octets.every((part) => part >= 0 && part <= 255);
}

function normalizeCodexBarDashboardUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw dashboardError('unsafe-url', options);
  }
  const safeHost = parsed.hostname === 'localhost' || isIpv4Loopback(parsed.hostname);
  if (
    parsed.protocol !== 'http:'
    || !safeHost
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw dashboardError('unsafe-url', options);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function producerVersion(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(raw) ? raw : '';
}

function providerStatus(provider) {
  if (provider.enabled === false) return 'disabled';
  if (provider.error !== null && provider.error !== undefined) return 'error';
  return 'ok';
}

function windowKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'session') return 'session';
  if (raw === 'weekly' || raw.startsWith('claude-weekly-scoped-')) return 'weekly';
  if (raw === 'billing' || raw === 'monthly') return 'billing';
  return null;
}

function projectBalance(credits) {
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)) return null;
  const amount = Number(credits.remaining);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = typeof credits.unit === 'string' ? credits.unit.trim().toUpperCase() : '';
  return {
    amount,
    currency: unit.slice(0, 8) || null
  };
}

function projectProvider(provider, canonicalId, context) {
  const windows = [];
  const enabledWindows = provider.enabled === false
    ? []
    : (Array.isArray(provider.windows) ? provider.windows : []);
  for (const window of enabledWindows) {
    if (!window || typeof window !== 'object' || Array.isArray(window)) {
      context.diagnostics.push(diagnostic('unknown-window', context));
      continue;
    }
    const kind = windowKind(window.kind);
    if (!kind) {
      context.diagnostics.push(diagnostic('unknown-window', context));
      continue;
    }
    windows.push({
      kind,
      label: window.label,
      usedPercent: window.usedPercent,
      resetAt: window.resetAt
    });
  }
  const balance = provider.enabled === false ? null : projectBalance(provider.credits);
  return {
    provider: canonicalId,
    status: providerStatus(provider),
    source: provider.source,
    updatedAt: provider.updatedAt || provider.status?.updatedAt || context.producedAt,
    windows,
    ...(balance ? { balance } : {}),
    producer: 'codexbar',
    producerVersion: context.producerVersion,
    producedAt: context.producedAt,
    staleAfterMs: context.staleAfterMs
  };
}

function parseCodexBarDashboardSnapshot(payload, options = {}) {
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw dashboardError('invalid-payload', { nowMs });
  }
  const schemaVersion = finiteNumber(payload.schemaVersion);
  if (schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
    throw dashboardError('incompatible-schema', { nowMs, schemaVersion });
  }
  const generatedAt = isoTimestamp(payload.generatedAt);
  const staleAfterSeconds = finiteNumber(payload.staleAfterSeconds);
  if (
    !generatedAt
    || staleAfterSeconds === null
    || staleAfterSeconds <= 0
    || staleAfterSeconds > Number.MAX_SAFE_INTEGER / 1000
    || !Array.isArray(payload.providers)
  ) {
    throw dashboardError('invalid-payload', { nowMs, schemaVersion });
  }
  const staleAfterMs = staleAfterSeconds * 1000;
  if (nowMs - Date.parse(generatedAt) > staleAfterMs) {
    throw dashboardError('stale', { nowMs, schemaVersion });
  }

  const version = producerVersion(payload.host?.codexBarVersion);
  const diagnostics = [];
  const directIds = new Set(payload.providers
    .map((provider) => safeProviderId(provider?.id))
    .filter((id) => id && VALID_PROVIDERS.has(id)));
  const seen = new Set();
  const providers = [];

  for (const provider of payload.providers) {
    const rawId = safeProviderId(provider?.id);
    if (!provider || typeof provider !== 'object' || Array.isArray(provider) || !rawId) {
      diagnostics.push(diagnostic('unknown-provider', { nowMs, schemaVersion, providerId: rawId }));
      continue;
    }
    const aliasTarget = PROVIDER_ALIASES.get(rawId);
    if (aliasTarget && directIds.has(aliasTarget)) {
      diagnostics.push(diagnostic('ambiguous-alias', { nowMs, schemaVersion, providerId: rawId }));
      continue;
    }
    const canonicalId = VALID_PROVIDERS.has(rawId) ? rawId : aliasTarget;
    if (!canonicalId) {
      diagnostics.push(diagnostic('unknown-provider', { nowMs, schemaVersion, providerId: rawId }));
      continue;
    }
    if (seen.has(canonicalId)) {
      diagnostics.push(diagnostic(aliasTarget ? 'ambiguous-alias' : 'unknown-provider', {
        nowMs,
        schemaVersion,
        providerId: rawId
      }));
      continue;
    }
    seen.add(canonicalId);
    providers.push(projectProvider(provider, canonicalId, {
      diagnostics,
      nowMs,
      producedAt: generatedAt,
      producerVersion: version,
      providerId: rawId,
      schemaVersion,
      staleAfterMs
    }));
  }

  const refreshMs = finiteNumber(options.refreshMs);
  const limits = normalizeLimitsSummary({
    updatedAt: generatedAt,
    refreshMs: refreshMs !== null && refreshMs > 0 ? refreshMs : DEFAULT_LIMITS_REFRESH_MS,
    providers
  });
  return {
    limits,
    meta: {
      schemaVersion,
      producer: 'codexbar',
      producerVersion: version,
      generatedAt,
      staleAfterMs
    },
    diagnostics
  };
}

function boundedPositiveInteger(value, fallback) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.floor(number) : fallback;
}

async function readBoundedText(response, maxBytes, errorOptions) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw dashboardError('payload-too-large', errorOptions);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw dashboardError('payload-too-large', errorOptions);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw dashboardError('payload-too-large', errorOptions);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function fetchCodexBarDashboard(options = {}) {
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const baseUrl = normalizeCodexBarDashboardUrl(options.baseUrl, { nowMs });
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (!token || /[\u0000-\u0020\u007f]/.test(token)) {
    throw dashboardError('unauthorized', { nowMs });
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw dashboardError('unavailable', { nowMs });

  const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (options.signal?.aborted) throw dashboardError('aborted', { nowMs });
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(dashboardError(timedOut ? 'timeout' : 'aborted', { nowMs }));
    }, { once: true });
  });
  const request = (async () => {
    const response = await fetchImpl(`${baseUrl}${DASHBOARD_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    });
    const httpStatus = finiteNumber(response?.status);
    if (httpStatus === 401 || httpStatus === 403) {
      throw dashboardError('unauthorized', { nowMs, httpStatus });
    }
    if (!response || response.ok !== true || httpStatus === null) {
      throw dashboardError('unavailable', { nowMs, httpStatus });
    }
    const text = await readBoundedText(response, maxBytes, { nowMs, httpStatus });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw dashboardError('invalid-json', { nowMs, httpStatus });
    }
    try {
      return parseCodexBarDashboardSnapshot(payload, {
        nowMs,
        refreshMs: options.refreshMs
      });
    } catch (error) {
      if (!(error instanceof CodexBarDashboardError) || error.httpStatus !== null) throw error;
      throw dashboardError(error.code, {
        nowMs,
        httpStatus,
        schemaVersion: error.schemaVersion,
        providerId: error.providerId
      });
    }
  })();

  try {
    return await Promise.race([request, aborted]);
  } catch (error) {
    if (error instanceof CodexBarDashboardError) throw error;
    if (timedOut) throw dashboardError('timeout', { nowMs });
    if (options.signal?.aborted || controller.signal.aborted) {
      throw dashboardError('aborted', { nowMs });
    }
    throw dashboardError('unavailable', { nowMs });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

module.exports = {
  CodexBarDashboardError,
  fetchCodexBarDashboard,
  normalizeCodexBarDashboardUrl,
  parseCodexBarDashboardSnapshot
};
