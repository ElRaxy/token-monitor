'use strict';

const crypto = require('node:crypto');
const { fetchCodexBarDashboard } = require('./codexbarDashboard');
const {
  PROVIDER_CLEANUP_GRACE_MS,
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  parseBoolean,
  parseLimitProviders,
  probeLimitProvider,
  providerPhysicalBoundMs
} = require('./limitCollector');
const { normalizeLimitProvider, normalizeLimitsSummary } = require('./limits');
const {
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
} = require('./limitResetBoundary');
const {
  LIMITS_ADAPTIVE_BASE_MS,
  createLimitsBurnState,
  markLimitsProbeSuccess,
  nextLimitsUrgencyRefresh,
  pruneLimitsBurnState,
  recordLimitsSample,
  recordLimitsUrgencyAttempt
} = require('./limitsBurnRate');
const { runWithProbeDeadline } = require('./probeDeadline');
const {
  DEFAULT_LIMITS_RETRY_BASE_MS,
  DEFAULT_LIMITS_RETRY_MAX_MS,
  computeRetryDelayMs,
  isRetryableLimitStatus
} = require('./limitsRetryPolicy');

const DEFAULT_LIMITS_MAX_CONCURRENCY = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const TRANSIENT_STATUSES = new Set([
  'timeout',
  'rateLimited',
  'sourceRateLimited',
  'unavailable',
  'error'
]);

const SAFE_CODEXBAR_ERROR_CODES = new Set([
  'aborted',
  'ambiguous-alias',
  'incompatible-schema',
  'invalid-json',
  'invalid-payload',
  'ownership-mismatch',
  'payload-too-large',
  'stale',
  'timeout',
  'unauthorized',
  'unavailable',
  'unknown-provider',
  'unknown-window',
  'unsafe-url'
]);

const COOLDOWN_BYPASS_REASONS = new Set([
  'account-added',
  'account-state',
  'credential-change',
  'credential-edit',
  'credential-save',
  'enabled',
  'identity-switch',
  'login',
  'profile-rename',
  'profile-save',
  'profile-state',
  'provider-added',
  'settings-change',
  'system-account-switch'
]);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
  return copy;
}

function clean(value) {
  return String(value || '').trim();
}

function providerId(value) {
  return clean(value).toLowerCase();
}

function parseCodexBarDelegatedProviders(value) {
  if (value === undefined || value === null || value === '') return new Set();
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return new Set(raw.map(providerId).filter(Boolean));
}

function codexBarOwnershipState(value = {}) {
  return {
    enabled: parseBoolean(value.codexbarDashboardEnabled, false),
    baseUrl: clean(value.codexbarDashboardUrl),
    token: clean(value.codexbarDashboardToken),
    providers: parseCodexBarDelegatedProviders(value.codexbarDelegatedProviders)
  };
}

function sameProviderSet(left, right) {
  if (left.size !== right.size) return false;
  for (const provider of left) {
    if (!right.has(provider)) return false;
  }
  return true;
}

function codexBarConfigChanged(previous, next) {
  if (previous.enabled !== next.enabled || !sameProviderSet(previous.providers, next.providers)) {
    return true;
  }
  if (!previous.enabled && !next.enabled) return false;
  return previous.baseUrl !== next.baseUrl || previous.token !== next.token;
}

function codexBarOwnedProviders(state) {
  return state.enabled ? state.providers : new Set();
}

function withCodexBarOwnership(value, ownership) {
  return {
    ...cloneValue(value),
    codexbarDashboardEnabled: ownership.enabled,
    codexbarDashboardUrl: ownership.baseUrl,
    codexbarDashboardToken: ownership.token,
    codexbarDelegatedProviders: [...ownership.providers]
  };
}

function codexBarOwnershipMismatch(value, ownership) {
  if (!value || typeof value !== 'object') return false;
  const resolved = codexBarOwnershipState(value);
  return (
    (Object.hasOwn(value, 'codexbarDashboardEnabled') && resolved.enabled !== ownership.enabled)
    || (Object.hasOwn(value, 'codexbarDashboardUrl') && resolved.baseUrl !== ownership.baseUrl)
    || (Object.hasOwn(value, 'codexbarDashboardToken') && resolved.token !== ownership.token)
    || (
      Object.hasOwn(value, 'codexbarDelegatedProviders')
      && !sameProviderSet(resolved.providers, ownership.providers)
    )
  );
}

function ownershipMismatchError() {
  return { code: 'ownership-mismatch', status: 'unavailable' };
}

function withoutCodexBarToken(value) {
  const copy = cloneValue(value);
  delete copy.codexbarDashboardToken;
  return copy;
}

function codexBarLastGoodIsFresh(row, nowMs) {
  if (row?.producer !== 'codexbar') return true;
  const producedAtMs = Date.parse(row.producedAt);
  const staleAfterMs = Number(row.staleAfterMs);
  return Number.isFinite(producedAtMs)
    && Number.isFinite(staleAfterMs)
    && staleAfterMs > 0
    && nowMs <= producedAtMs + staleAfterMs;
}

function safeCodexBarErrorCode(error) {
  const code = clean(error?.code).toLowerCase();
  if (code === 'probe_timeout' || clean(error?.status).toLowerCase() === 'timeout') return 'timeout';
  return SAFE_CODEXBAR_ERROR_CODES.has(code) ? code : '';
}

function codexBarErrorStatus(error) {
  const code = safeCodexBarErrorCode(error);
  if (code === 'unauthorized') return 'unauthorized';
  if (code === 'timeout') return 'timeout';
  return 'unavailable';
}

function safeCodexBarFailure(error) {
  const code = safeCodexBarErrorCode(error) || 'unavailable';
  return { code, status: codexBarErrorStatus({ code }) };
}

function dashboardAbortError(reason) {
  const message = reason instanceof Error ? reason.message : String(reason || 'CodexBar request aborted');
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'aborted';
  error.status = 'unavailable';
  return error;
}

function signalAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : dashboardAbortError(signal?.reason);
}

function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signalAbortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function privateCredentialDigest(provider, value) {
  return crypto.createHash('sha256').update(`${provider}\0${value}`).digest('hex').slice(0, 24);
}

function accountIdentityDescriptor(value) {
  for (const [name, raw] of [
    ['accountKey', value?.accountKey],
    ['id', value?.accountId ?? value?.managedAccountId ?? value?.id],
    ['email', value?.accountEmail ?? value?.email],
    ['name', value?.accountName ?? value?.name],
    ['label', value?.accountLabel]
  ]) {
    const normalized = clean(raw).toLowerCase();
    if (normalized) return { name, value: normalized, part: `${name}:${normalized}` };
  }
  return null;
}

function accountIdentityPart(value) {
  return accountIdentityDescriptor(value)?.part || '';
}

function accountIdentityField(value, name) {
  if (name === 'accountKey') return value?.accountKey;
  if (name === 'id') return value?.accountId ?? value?.managedAccountId ?? value?.id;
  if (name === 'email') return value?.accountEmail ?? value?.email;
  if (name === 'name') return value?.accountName ?? value?.name;
  if (name === 'label') return value?.accountLabel;
  return '';
}

function rowMatchesScope(row, scope) {
  const descriptor = accountIdentityDescriptor(scope);
  if (!descriptor) return false;
  return clean(accountIdentityField(row, descriptor.name)).toLowerCase() === descriptor.value;
}

function credentialIdentityPart(provider, value) {
  for (const field of ['credential', 'token', 'apiKey', 'cookie', 'accessToken', 'refreshToken']) {
    const raw = clean(value?.[field]);
    if (raw) return `private:${privateCredentialDigest(provider, raw)}`;
  }
  return '';
}

function scopeIdentityKey(scope) {
  const provider = providerId(scope?.provider);
  const identity = accountIdentityPart(scope) || credentialIdentityPart(provider, scope);
  return identity ? `${provider}:${identity}` : `${provider}:*`;
}

function isAccountScope(scope) {
  return Boolean(accountIdentityPart(scope) || credentialIdentityPart(providerId(scope?.provider), scope));
}

function normalizedScope(scope) {
  if (!scope || typeof scope !== 'object') return { provider: '' };
  return { ...cloneValue(scope), provider: providerId(scope.provider) };
}

function rowIdentityKey(row) {
  const provider = providerId(row?.provider);
  const identity = accountIdentityPart(row);
  return identity ? `${provider}:${identity}` : `${provider}:*`;
}

function publicAttemptStatus(status) {
  return status === 'timeout' ? 'error' : status || 'unavailable';
}

function bypassesProviderCooldown(reason) {
  return COOLDOWN_BYPASS_REASONS.has(String(reason || ''));
}

function createLimitsRuntime(initialOptions = {}, deps = {}) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const scheduleMicrotask = deps.queueMicrotask || queueMicrotask;
  const probeProvider = deps.probeProvider || probeLimitProvider;
  const physicalBound = deps.providerPhysicalBoundMs || providerPhysicalBoundMs;
  const resetBoundary = deps.nextLimitsResetBoundary || nextLimitsResetBoundary;
  const cleanupGraceMs = Number.isFinite(Number(deps.cleanupGraceMs))
    ? Math.max(0, Number(deps.cleanupGraceMs))
    : PROVIDER_CLEANUP_GRACE_MS;
  const maxConcurrency = Number.isFinite(Number(deps.maxConcurrency))
    ? Math.max(1, Math.floor(Number(deps.maxConcurrency)))
    : DEFAULT_LIMITS_MAX_CONCURRENCY;
  const retryBaseMs = Number.isFinite(Number(deps.retryBaseMs))
    ? Math.max(1, Number(deps.retryBaseMs))
    : DEFAULT_LIMITS_RETRY_BASE_MS;
  const retryMaxMs = Number.isFinite(Number(deps.retryMaxMs))
    ? Math.max(retryBaseMs, Number(deps.retryMaxMs))
    : DEFAULT_LIMITS_RETRY_MAX_MS;
  const autoRetry = deps.autoRetry !== false;
  const random = deps.random || Math.random;
  const providerRuntimeState = deps.providerRuntimeState instanceof Map
    ? deps.providerRuntimeState
    : new Map();
  const fetchDashboard = deps.fetchCodexBarDashboard || fetchCodexBarDashboard;

  let config = cloneValue(initialOptions);
  let enabled = parseBoolean(config.limitsEnabled ?? config.enabled, true);
  let refreshMode = normalizeLimitsRefreshMode(config.limitsRefreshMode);
  // Adaptive replaces the chosen interval with its own baseline rather than
  // modifying it, so the stored limitsRefreshMs survives a round trip through
  // adaptive and back. Everything downstream, including the refreshMs published
  // on the wire, then describes the cadence actually in effect.
  let refreshMs = refreshMode === 'adaptive'
    ? LIMITS_ADAPTIVE_BASE_MS
    : normalizeLimitsRefreshMs(config.limitsRefreshMs ?? config.refreshMs);
  let configuredProviders = new Set(parseLimitProviders(config.limitProviders ?? config.providers));
  let runtimeEpoch = 1;
  let stopped = false;
  let started = false;
  let sequence = 0;
  let executorActive = 0;
  let pumpQueued = false;
  let intervalTimer = null;
  let resetTimer = null;
  let urgencyTimer = null;
  let dashboardExpiryTimer = null;
  let lastScheduledFullAt = 0;
  let dashboardGeneration = 1;
  let nextDashboardBatchId = 1;
  const burnState = createLimitsBurnState();
  const listeners = new Set();
  const lanes = new Map();
  const dashboardBatches = new Set();
  const providerQueue = [];
  const queuedProviders = new Set();
  const attemptedResetBoundaries = new Set();
  let snapshot = normalizeLimitsSummary({ updatedAt: null, refreshMs, providers: [] });

  function createDashboardBatch() {
    return {
      id: nextDashboardBatchId++,
      generation: dashboardGeneration,
      consumers: 0,
      tracked: false,
      invalidated: false,
      settled: false,
      baseUrl: '',
      token: '',
      controller: null,
      promise: null
    };
  }

  function retainDashboardBatch(batch) {
    batch.consumers += 1;
    if (batch.tracked) return;
    batch.tracked = true;
    dashboardBatches.add(batch);
  }

  function releaseDashboardBatch(batch) {
    if (!batch) return;
    batch.consumers = Math.max(0, batch.consumers - 1);
    if (batch.consumers > 0) return;
    if (batch.tracked) dashboardBatches.delete(batch);
    batch.tracked = false;
    if (!batch.settled && batch.controller && !batch.controller.signal.aborted) {
      batch.controller.abort(dashboardAbortError('CodexBar batch has no consumers'));
    }
  }

  function invalidateDashboardBatches(reason) {
    dashboardGeneration += 1;
    for (const batch of dashboardBatches) {
      batch.invalidated = true;
      batch.tracked = false;
      if (batch.controller && !batch.controller.signal.aborted) {
        batch.controller.abort(dashboardAbortError(reason));
      }
    }
    dashboardBatches.clear();
  }

  function sharedDashboardSnapshot(ownership, batch) {
    if (!batch || batch.invalidated || batch.generation !== dashboardGeneration) {
      return Promise.reject(dashboardAbortError('CodexBar batch superseded'));
    }
    if (batch.promise) {
      if (batch.baseUrl !== ownership.baseUrl || batch.token !== ownership.token) {
        return Promise.reject(dashboardAbortError('CodexBar batch configuration changed'));
      }
      return batch.promise;
    }
    const controller = new AbortController();
    batch.baseUrl = ownership.baseUrl;
    batch.token = ownership.token;
    batch.controller = controller;
    const fetchOptions = {
      baseUrl: ownership.baseUrl,
      token: ownership.token,
      signal: controller.signal,
      nowMs: now(),
      refreshMs,
      ...(typeof deps.codexbarFetch === 'function' ? { fetchImpl: deps.codexbarFetch } : {})
    };
    const raw = Promise.resolve().then(() => fetchDashboard(fetchOptions));
    batch.promise = raceWithAbort(raw, controller.signal).then(
      (result) => {
        batch.settled = true;
        return result;
      },
      (error) => {
        batch.settled = true;
        throw error;
      }
    );
    return batch.promise;
  }

  function dashboardUnavailableRow(provider, meta = {}) {
    return {
      provider,
      status: 'unavailable',
      source: '',
      updatedAt: meta.generatedAt || new Date(now()).toISOString(),
      windows: [],
      producer: 'codexbar',
      ...(meta.producerVersion ? { producerVersion: meta.producerVersion } : {}),
      ...(meta.generatedAt ? { producedAt: meta.generatedAt } : {}),
      ...(Number(meta.staleAfterMs) > 0 ? { staleAfterMs: Number(meta.staleAfterMs) } : {})
    };
  }

  async function probeCodexBarProvider(provider, ownership, signal, batch) {
    if (signal?.aborted) throw signalAbortError(signal);
    const shared = sharedDashboardSnapshot(ownership, batch);
    const result = await raceWithAbort(shared, signal);
    const rows = Array.isArray(result?.limits?.providers) ? result.limits.providers : [];
    const matching = rows.filter((row) => providerId(row?.provider) === provider);
    return matching.length > 0 ? matching : [dashboardUnavailableRow(provider, result?.meta)];
  }

  function laneFor(provider) {
    if (!lanes.has(provider)) {
      lanes.set(provider, {
        provider,
        epoch: 0,
        accountRevisions: new Map(),
        pending: new Map(),
        active: null,
        identities: new Map(),
        retryAttempt: 0,
        retryNotBefore: 0,
        retryScope: null,
        retryTimer: null
      });
    }
    return lanes.get(provider);
  }

  function finishIntent(intent, result) {
    if (!intent || intent.settled) return;
    intent.settled = true;
    if (intent.dashboardBatchRetained) {
      intent.dashboardBatchRetained = false;
      releaseDashboardBatch(intent.dashboardBatch);
    }
    intent.resolve(result);
  }

  function setDashboardBatchRetained(intent, retained) {
    if (!intent || intent.dashboardBatchRetained === retained) return;
    intent.dashboardBatchRetained = retained;
    if (retained) retainDashboardBatch(intent.dashboardBatch);
    else releaseDashboardBatch(intent.dashboardBatch);
  }

  function emitEvent(type, provider, detail = {}) {
    try {
      deps.onEvent?.({
        type,
        provider,
        active: executorActive,
        queued: providerQueue.length,
        ...detail
      });
    } catch (_) {
      // Diagnostics observers must never affect collection or retry state.
    }
  }

  function clearRetryTimer(lane) {
    if (lane.retryTimer !== null) clearTimer(lane.retryTimer);
    lane.retryTimer = null;
  }

  function resetRetryPolicy(lane) {
    clearRetryTimer(lane);
    lane.retryAttempt = 0;
    lane.retryNotBefore = 0;
    lane.retryScope = null;
  }

  function scheduleRetryTimer(lane) {
    clearRetryTimer(lane);
    if (!autoRetry || stopped || !enabled || !configuredProviders.has(lane.provider) || !lane.retryScope) return;
    const delayMs = Math.max(0, lane.retryNotBefore - now());
    lane.retryTimer = setTimer(() => {
      lane.retryTimer = null;
      if (stopped || !enabled || !configuredProviders.has(lane.provider)) return;
      lane.retryNotBefore = 0;
      void queueScope(cloneValue(lane.retryScope), 'retry');
    }, delayMs);
  }

  function retryStatus(rawRows, error) {
    if (error) {
      const status = error.status || (error.code === 'PROBE_TIMEOUT' ? 'timeout' : 'unavailable');
      return isRetryableLimitStatus(status) ? status : '';
    }
    const rows = Array.isArray(rawRows) ? rawRows : rawRows?.providers || [];
    return rows.map((row) => String(row?.status || '')).find(isRetryableLimitStatus) || '';
  }

  function applyRetryPolicy(lane, intent, rawRows, error, retryAfterMs) {
    const status = retryStatus(rawRows, error);
    if (!status) {
      resetRetryPolicy(lane);
      return;
    }
    lane.retryAttempt += 1;
    const delayMs = computeRetryDelayMs(lane.retryAttempt, {
      baseMs: retryBaseMs,
      maxMs: retryMaxMs,
      random,
      retryAfterMs
    });
    lane.retryNotBefore = now() + delayMs;
    lane.retryScope = cloneValue(intent.scope);
    scheduleRetryTimer(lane);
    emitEvent('retry-scheduled', lane.provider, {
      attempt: lane.retryAttempt,
      delayMs,
      reason: status,
      retryAfter: Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
    });
  }

  function cancelLane(lane, reason = 'superseded') {
    lane.epoch += 1;
    lane.active?.controller.abort(new Error(reason));
    finishIntent(lane.active?.intent, { superseded: true, reason });
    for (const intent of lane.pending.values()) {
      finishIntent(intent, { superseded: true, reason });
    }
    lane.pending.clear();
  }

  function providerRows(provider) {
    const lane = lanes.get(provider);
    if (!lane) return [];
    const rows = [];
    for (const state of lane.identities.values()) {
      const attempt = state.lastAttempt;
      if (!attempt) continue;
      const codexBarExpired = state.lastGood?.producer === 'codexbar'
        && !codexBarLastGoodIsFresh(state.lastGood, now());
      const status = codexBarExpired ? 'unavailable' : publicAttemptStatus(attempt.status);
      const expiredProvenance = codexBarExpired ? {
        producer: 'codexbar',
        ...(state.lastGood.producerVersion
          ? { producerVersion: state.lastGood.producerVersion }
          : {}),
        ...(state.lastGood.producedAt ? { producedAt: state.lastGood.producedAt } : {}),
        ...(Number(state.lastGood.staleAfterMs) > 0
          ? { staleAfterMs: Number(state.lastGood.staleAfterMs) }
          : {})
      } : {};
      const row = codexBarExpired
        ? normalizeLimitProvider({
            provider,
            source: state.lastGood.source || '',
            status,
            updatedAt: attempt.at,
            windows: [],
            ...expiredProvenance
          })
        : state.lastGood
          ? normalizeLimitProvider({ ...state.lastGood, status })
          : normalizeLimitProvider({
              ...(attempt.row || {}),
              provider,
              status,
              updatedAt: attempt.at,
              windows: []
            });
      if (row) rows.push(row);
    }
    return rows;
  }

  function rebuildSnapshot() {
    const providers = [];
    if (enabled && !stopped) {
      for (const provider of configuredProviders) providers.push(...providerRows(provider));
    }
    snapshot = normalizeLimitsSummary({
      updatedAt: new Date(now()).toISOString(),
      refreshMs,
      providers
    });
    pruneAttemptedResetBoundaries(snapshot, attemptedResetBoundaries);
    // Only sample once this runtime is actually polling. The constructor seeds
    // rows from previousLimits that can be arbitrarily old, and pairing that
    // seed with the first live probe would read a whole offline session's
    // consumption as having happened in the milliseconds between the two.
    if (started && !stopped) {
      recordLimitsSample(burnState, snapshot, now());
      pruneLimitsBurnState(burnState, snapshot);
    }
    scheduleResetTimer();
    scheduleUrgencyTimer();
    scheduleDashboardExpiryTimer();
    const published = cloneValue(snapshot);
    deps.onUpdate?.(published);
    for (const listener of listeners) listener(published);
    return published;
  }

  function clearDashboardExpiryTimer() {
    if (dashboardExpiryTimer !== null) clearTimer(dashboardExpiryTimer);
    dashboardExpiryTimer = null;
  }

  function scheduleDashboardExpiryTimer() {
    clearDashboardExpiryTimer();
    if (stopped || !enabled) return;
    const nowMs = now();
    let nearestExpiry = Number.POSITIVE_INFINITY;
    for (const provider of configuredProviders) {
      const lane = lanes.get(provider);
      if (!lane) continue;
      for (const state of lane.identities.values()) {
        const row = state.lastGood;
        if (row?.producer !== 'codexbar') continue;
        const producedAtMs = Date.parse(row.producedAt);
        const staleAfterMs = Number(row.staleAfterMs);
        if (!Number.isFinite(producedAtMs) || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
          continue;
        }
        const expiresAt = producedAtMs + staleAfterMs;
        if (expiresAt >= nowMs) nearestExpiry = Math.min(nearestExpiry, expiresAt);
      }
    }
    if (!Number.isFinite(nearestExpiry)) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, nearestExpiry - nowMs + 1)
    );
    dashboardExpiryTimer = setTimer(() => {
      dashboardExpiryTimer = null;
      if (stopped || !enabled) return;
      rebuildSnapshot();
    }, delayMs);
  }

  function scheduleResetTimer() {
    if (resetTimer !== null) {
      clearTimer(resetTimer);
      resetTimer = null;
    }
    if (!started || stopped || !enabled) return;
    const next = resetBoundary(snapshot, now(), attemptedResetBoundaries);
    if (!next) return;
    resetTimer = setTimer(() => {
      resetTimer = null;
      for (const key of next.keys || []) attemptedResetBoundaries.add(key);
      for (const scope of next.scopes || []) {
        const provider = providerId(scope.provider);
        const rows = snapshot.providers.filter((row) => row.provider === provider);
        const strongIdentity = clean(scope.accountKey || scope.accountEmail || scope.accountName);
        if (!configuredProviders.has(provider) || (rows.length > 1 && !strongIdentity)) continue;
        void refresh(scope, 'reset-boundary');
      }
      scheduleResetTimer();
    }, next.delayMs);
  }

  // An urgency probe must stand down only when the lane is already doing work
  // that covers this exact scope. A lane serialises probes, but account-scoped
  // work queues behind other accounts without cancelling them, so an account
  // close to exhaustion has to be allowed to take its place in that queue rather
  // than forfeit its turn and wait another floor for a probe that was never
  // about it.
  function urgencyScopeCovered(lane, scope) {
    if (!lane) return false;
    const active = lane.active?.intent;
    const pending = [...lane.pending.values()];
    // A provider-wide dispatch aborts whatever is running and empties the queue,
    // so anything in progress makes it destructive rather than merely redundant.
    if (!isAccountScope(scope)) return Boolean(active) || pending.length > 0;
    // A provider-wide refresh, running or queued, answers for every account.
    if (active && !active.accountScoped) return true;
    if (lane.pending.has(`${lane.provider}:*`)) return true;
    // Work already aimed at this same account, which dispatching would supersede.
    if (active?.accountScoped && rowMatchesScope(scope, active.scope)) return true;
    return pending.some((intent) => rowMatchesScope(scope, intent.scope));
  }

  function clearUrgencyTimer() {
    if (urgencyTimer !== null) clearTimer(urgencyTimer);
    urgencyTimer = null;
  }

  // A second data-driven timer alongside scheduleResetTimer(), active only in
  // adaptive mode. The 5-minute baseline still applies to every provider; this
  // inserts an earlier, provider-scoped probe for a quota whose burn rate says
  // it is close to running out, never faster than the floor in limitsBurnRate.
  // 'burn-rate' is deliberately absent from COOLDOWN_BYPASS_REASONS, so
  // queueScope defers it whenever the lane is already backing off.
  function scheduleUrgencyTimer() {
    clearUrgencyTimer();
    if (!started || stopped || !enabled || refreshMode !== 'adaptive') return;
    const due = nextLimitsUrgencyRefresh(snapshot, burnState, now(), { baseRefreshMs: refreshMs });
    if (!due) return;
    urgencyTimer = setTimer(() => {
      urgencyTimer = null;
      // Recorded for every key rather than only the dispatched ones, so a scope
      // skipped below still consumes its deadline instead of re-firing at once.
      recordLimitsUrgencyAttempt(burnState, due.keys, now());
      for (const [index, scope] of (due.scopes || []).entries()) {
        const provider = providerId(scope.provider);
        const rows = snapshot.providers.filter((row) => row.provider === provider);
        const strongIdentity = clean(scope.accountKey || scope.accountEmail || scope.accountName);
        if (!configuredProviders.has(provider) || (rows.length > 1 && !strongIdentity)) continue;
        // A lane already running a probe is skipped whatever queued it: an
        // intent superseded by another refresh resolves its promise at once
        // while the physical probe keeps running, so inFlight alone would let an
        // urgency tick disturb work the lane is already doing. The attempt above
        // was already recorded for this key, so a scope that stands down waits a
        // floor rather than retrying against a lane that already covers it.
        //
        // urgencyScopeCovered compares through rowMatchesScope rather than by
        // identity key, because an account is addressable by several aliases and
        // callers enqueue whichever one they hold: a row carrying both
        // accountKey and accountName yields the accountKey form here, while a
        // profile refresh enqueues the name form.
        if (urgencyScopeCovered(lanes.get(provider), scope)) continue;
        // Held until the probe settles, not merely until it is dispatched. The
        // lane is latest-wins, so re-scheduling a scope whose probe is still
        // running aborts that probe: a provider slower than the floor would
        // otherwise never publish a reading, only cancelled requests.
        const key = due.keys[index];
        burnState.inFlight.add(key);
        void refresh(scope, 'burn-rate').finally(() => {
          burnState.inFlight.delete(key);
          scheduleUrgencyTimer();
        });
      }
      // Re-armed unconditionally: whatever was just dispatched is now in
      // inFlight and skipped, so this picks up the next provider due rather than
      // leaving it to wait behind a probe that can legitimately run for two
      // minutes. Lanes are per provider and the executor is concurrent, so there
      // is nothing to serialise across them.
      scheduleUrgencyTimer();
    }, due.delayMs);
  }

  function clearIntervalTimer() {
    if (intervalTimer !== null) clearTimer(intervalTimer);
    intervalTimer = null;
  }

  function scheduleInterval(delayMs = refreshMs) {
    clearIntervalTimer();
    if (!started || stopped || !enabled) return;
    intervalTimer = setTimer(() => {
      intervalTimer = null;
      runScheduledFullRefresh();
    }, Math.max(0, delayMs));
  }

  function runScheduledFullRefresh() {
    if (!started || stopped || !enabled) return;
    lastScheduledFullAt = now();
    void refresh({}, 'interval');
    scheduleInterval(refreshMs);
  }

  function enqueueProvider(provider) {
    const lane = lanes.get(provider);
    if (!lane || lane.active || lane.pending.size === 0 || queuedProviders.has(provider)) return;
    queuedProviders.add(provider);
    providerQueue.push(provider);
    if (!pumpQueued) {
      pumpQueued = true;
      scheduleMicrotask(() => {
        pumpQueued = false;
        void pump();
      });
    }
  }

  function nextIntent(lane) {
    let selected = null;
    for (const intent of lane.pending.values()) {
      if (!selected || intent.sequence < selected.sequence) selected = intent;
    }
    if (selected) lane.pending.delete(selected.key);
    return selected;
  }

  function accountRevisionStillCurrent(lane, identityKey, dispatch) {
    return (lane.accountRevisions.get(identityKey) || 0) === (dispatch.accountRevisions.get(identityKey) || 0);
  }

  function applyAttempt(lane, identityKey, row, status, at, code = '') {
    const existing = lane.identities.get(identityKey) || {
      identityKey,
      lastGood: null,
      lastAttempt: null
    };
    if (status === 'ok') {
      existing.lastGood = row;
    } else if (!TRANSIENT_STATUSES.has(status)) {
      existing.lastGood = null;
    }
    existing.lastAttempt = {
      status,
      at,
      row,
      ...(code ? { code } : {})
    };
    lane.identities.set(identityKey, existing);
  }

  function matchingIdentityKeys(lane, scope) {
    const keys = new Set([scopeIdentityKey(scope)]);
    for (const [identityKey, state] of lane.identities) {
      if (rowMatchesScope(state.lastGood, scope) || rowMatchesScope(state.lastAttempt?.row, scope)) {
        keys.add(identityKey);
      }
    }
    return keys;
  }

  function commitRows(lane, dispatch, rawRows, attemptError = null) {
    if (stopped || runtimeEpoch !== dispatch.runtimeEpoch || !enabled || !configuredProviders.has(lane.provider)) return false;
    if (dispatch.owner === 'codexbar' && dashboardGeneration !== dispatch.ownershipGeneration) return false;
    if (lane.epoch !== dispatch.providerEpoch) return false;
    if (dispatch.accountScoped) {
      const currentRevision = lane.accountRevisions.get(dispatch.identityKey) || 0;
      if (currentRevision !== dispatch.accountRevision) return false;
    }

    const attemptAt = new Date(now()).toISOString();
    const normalizedRows = (Array.isArray(rawRows) ? rawRows : rawRows?.providers || [])
      .map((row) => normalizeLimitProvider({ ...row, provider: lane.provider }))
      .filter(Boolean);
    const expected = new Set(dispatch.expectedIdentityKeys);
    const represented = new Set();

    if (attemptError) {
      const codexBarCode = dispatch.owner === 'codexbar'
        ? safeCodexBarErrorCode(attemptError)
        : '';
      const status = dispatch.owner === 'codexbar'
        ? codexBarErrorStatus(attemptError)
        : attemptError.status || (attemptError.code === 'PROBE_TIMEOUT' ? 'timeout' : 'unavailable');
      const targets = dispatch.accountScoped
        ? [dispatch.identityKey]
        : expected.size ? [...expected] : [`${lane.provider}:*`];
      for (const identityKey of targets) {
        if (!accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
        applyAttempt(lane, identityKey, {
          provider: lane.provider,
          ...(dispatch.owner === 'codexbar' ? { producer: 'codexbar' } : {})
        }, status, attemptAt, codexBarCode);
      }
      rebuildSnapshot();
      return true;
    }

    const genericTerminal = normalizedRows.length === 1
      && rowIdentityKey(normalizedRows[0]) === `${lane.provider}:*`
      && !TRANSIENT_STATUSES.has(normalizedRows[0].status)
      && normalizedRows[0].status !== 'ok';
    if (genericTerminal && !dispatch.accountScoped) lane.identities.clear();

    for (const row of normalizedRows) {
      let identityKey = rowIdentityKey(row);
      if (identityKey === `${lane.provider}:*` && dispatch.accountScoped) identityKey = dispatch.identityKey;
      if (!accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
      if (dispatch.accountScoped && identityKey !== dispatch.identityKey) identityKey = dispatch.identityKey;

      if (identityKey === `${lane.provider}:*` && TRANSIENT_STATUSES.has(row.status) && expected.size > 0) {
        for (const expectedKey of expected) {
          if (!accountRevisionStillCurrent(lane, expectedKey, dispatch)) continue;
          represented.add(expectedKey);
          applyAttempt(lane, expectedKey, row, row.status, attemptAt);
        }
        continue;
      }

      represented.add(identityKey);
      applyAttempt(lane, identityKey, row, row.status, attemptAt);
      // Marks the row as measurable by this runtime, so a persisted seed for a
      // provider that has not answered yet can never become a burn baseline.
      if (row.status === 'ok') markLimitsProbeSuccess(burnState, row);
    }

    if (!dispatch.accountScoped && !genericTerminal) {
      for (const identityKey of expected) {
        if (represented.has(identityKey) || !accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
        applyAttempt(lane, identityKey, { provider: lane.provider }, 'unavailable', attemptAt);
      }
    }
    rebuildSnapshot();
    return true;
  }

  async function dispatchIntent(lane, intent) {
    const controller = new AbortController();
    const dispatch = {
      runtimeEpoch,
      providerEpoch: lane.epoch,
      ownershipGeneration: intent.ownershipGeneration,
      accountScoped: intent.accountScoped,
      identityKey: intent.identityKey,
      accountRevision: lane.accountRevisions.get(intent.identityKey) || 0,
      accountRevisions: new Map(lane.accountRevisions),
      expectedIdentityKeys: [...lane.identities.keys()],
      owner: intent.owner
    };
    setDashboardBatchRetained(intent, intent.owner === 'codexbar');
    lane.active = { intent, controller, dispatch };
    emitEvent('probe-start', lane.provider, { reason: intent.reason });
    let reportedRetryAfterMs = null;
    try {
      const resolverBaseConfig = withCodexBarOwnership(config, intent.ownership);
      const resolved = deps.resolveConfigSnapshot
        ? await deps.resolveConfigSnapshot(cloneValue(intent.scope), cloneValue(resolverBaseConfig))
        : resolverBaseConfig;
      if (
        stopped
        || runtimeEpoch !== dispatch.runtimeEpoch
        || (dispatch.owner === 'codexbar' && dashboardGeneration !== dispatch.ownershipGeneration)
        || lane.epoch !== dispatch.providerEpoch
        || controller.signal.aborted
        || intent.settled
      ) {
        throw dashboardAbortError('provider dispatch superseded');
      }
      if (codexBarOwnershipMismatch(resolved, intent.ownership)) {
        throw ownershipMismatchError();
      }
      const configSnapshot = withCodexBarOwnership(resolved || resolverBaseConfig, intent.ownership);
      configSnapshot.limitProviders = [lane.provider];
      if (intent.accountScoped) configSnapshot.limitRefreshScope = cloneValue(intent.scope);
      else delete configSnapshot.limitRefreshScope;
      const dashboardOwned = intent.owner === 'codexbar';
      const nativeConfigSnapshot = withoutCodexBarToken(configSnapshot);
      const physicalMs = Number(physicalBound(lane.provider, nativeConfigSnapshot, deps));
      const deadlineMs = physicalMs + cleanupGraceMs;
      const rows = await runWithProbeDeadline(
        ({ signal }) => {
          const combinedSignal = AbortSignal.any([signal, controller.signal]);
          if (dashboardOwned) {
            return probeCodexBarProvider(
              lane.provider,
              intent.ownership,
              combinedSignal,
              intent.dashboardBatch
            );
          }
          return probeProvider(lane.provider, nativeConfigSnapshot, {
            signal: combinedSignal,
            deadlineMs,
            scope: cloneValue(intent.scope),
            reason: intent.reason,
            onRetryAfter(value) {
              const parsed = Number(value);
              if (!Number.isFinite(parsed) || parsed <= 0) return;
              reportedRetryAfterMs = Math.max(reportedRetryAfterMs || 0, parsed);
            }
          }, { ...deps, providerRuntimeState });
        },
        { deadlineMs }
      );
      const committed = commitRows(lane, dispatch, rows);
      if (committed) applyRetryPolicy(lane, intent, rows, null, reportedRetryAfterMs);
      finishIntent(intent, { superseded: !committed, snapshot: getSnapshot() });
    } catch (error) {
      const committed = commitRows(lane, dispatch, [], error);
      const safeError = dispatch.owner === 'codexbar' ? safeCodexBarFailure(error) : error;
      if (committed) {
        applyRetryPolicy(
          lane,
          intent,
          [],
          safeError,
          reportedRetryAfterMs || error?.retryAfterMs
        );
      }
      finishIntent(intent, { superseded: !committed, error: safeError, snapshot: getSnapshot() });
    } finally {
      if (lane.active?.intent === intent) lane.active = null;
      emitEvent('probe-finish', lane.provider, { reason: intent.reason });
    }
  }

  function pump() {
    if (stopped) return;
    while (executorActive < maxConcurrency && providerQueue.length > 0) {
      const provider = providerQueue.shift();
      queuedProviders.delete(provider);
      const lane = lanes.get(provider);
      if (!lane || lane.active || lane.pending.size === 0 || !configuredProviders.has(provider)) continue;
      const intent = nextIntent(lane);
      if (!intent) continue;
      executorActive += 1;
      void dispatchIntent(lane, intent).finally(() => {
        executorActive = Math.max(0, executorActive - 1);
        if (lane.pending.size > 0) enqueueProvider(provider);
        pump();
      });
    }
  }

  function queueScope(scope, reason, dashboardBatch = createDashboardBatch()) {
    const provider = providerId(scope?.provider);
    if (!provider || stopped || !enabled || !configuredProviders.has(provider)) {
      return Promise.resolve({ superseded: true, reason: 'disabled' });
    }
    const ownership = codexBarOwnershipState(config);
    const ownershipGeneration = dashboardGeneration;
    const owner = ownership.enabled && ownership.providers.has(provider) ? 'codexbar' : 'native';
    let requestedScope = normalizedScope(scope);
    if (owner === 'codexbar') requestedScope = { provider };
    const lane = laneFor(provider);
    if (bypassesProviderCooldown(reason)) {
      resetRetryPolicy(lane);
    } else if (lane.retryNotBefore > now()) {
      scheduleRetryTimer(lane);
      return Promise.resolve({
        deferred: true,
        provider,
        retryAt: new Date(lane.retryNotBefore).toISOString()
      });
    }
    const accountScoped = isAccountScope(requestedScope);
    const identityKey = scopeIdentityKey(requestedScope);
    const key = accountScoped ? identityKey : `${provider}:*`;

    if (accountScoped) {
      lane.accountRevisions.set(identityKey, (lane.accountRevisions.get(identityKey) || 0) + 1);
      if (lane.active?.intent.key === key) {
        lane.active.controller.abort(new Error('superseded'));
        finishIntent(lane.active.intent, { superseded: true, reason: 'superseded' });
      }
    } else {
      lane.epoch += 1;
      lane.active?.controller.abort(new Error('superseded'));
      finishIntent(lane.active?.intent, { superseded: true, reason: 'superseded' });
      for (const pending of lane.pending.values()) {
        finishIntent(pending, { superseded: true, reason: 'provider-wide' });
      }
      lane.pending.clear();
    }

    const previous = lane.pending.get(key);
    finishIntent(previous, { superseded: true, reason: 'superseded' });
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const intent = {
      sequence: ++sequence,
      key,
      identityKey,
      accountScoped,
      scope: cloneValue(requestedScope),
      reason,
      owner,
      ownership,
      ownershipGeneration,
      dashboardBatch,
      dashboardBatchRetained: false,
      resolve,
      settled: false
    };
    setDashboardBatchRetained(intent, owner === 'codexbar');
    lane.pending.set(key, intent);
    enqueueProvider(provider);
    return promise;
  }

  function refresh(scope = {}, reason = 'manual') {
    const normalized = normalizedScope(scope);
    const dashboardBatch = createDashboardBatch();
    if (normalized.provider) return queueScope(normalized, reason, dashboardBatch);
    if (reason === 'manual' && started && enabled && !stopped) {
      lastScheduledFullAt = now();
      scheduleInterval(refreshMs);
    }
    return Promise.all([...configuredProviders].map((provider) => (
      queueScope({ provider }, reason, dashboardBatch)
    )))
      .then(() => getSnapshot());
  }

  function clear(scope = {}, reason = 'removed') {
    let normalized = normalizedScope(scope);
    const ownership = codexBarOwnershipState(config);
    if (normalized.provider && ownership.enabled && ownership.providers.has(normalized.provider)) {
      normalized = { provider: normalized.provider };
    }
    const providers = normalized.provider ? [normalized.provider] : [...configuredProviders];
    for (const provider of providers) {
      const lane = lanes.get(provider);
      if (!lane) continue;
      if (!isAccountScope(normalized)) {
        cancelLane(lane, reason);
        resetRetryPolicy(lane);
        lane.identities.clear();
        lane.accountRevisions.clear();
        continue;
      }
      const identityKeys = matchingIdentityKeys(lane, normalized);
      resetRetryPolicy(lane);
      for (const identityKey of identityKeys) {
        lane.accountRevisions.set(identityKey, (lane.accountRevisions.get(identityKey) || 0) + 1);
        lane.identities.delete(identityKey);
        const pending = lane.pending.get(identityKey);
        finishIntent(pending, { superseded: true, reason });
        lane.pending.delete(identityKey);
      }
      if (identityKeys.has(lane.active?.intent.identityKey)) {
        lane.active.controller.abort(new Error(reason));
        finishIntent(lane.active.intent, { superseded: true, reason });
      }
    }
    return rebuildSnapshot();
  }

  function reconfigure(nextOptions = {}) {
    const previousEnabled = enabled;
    const previousRefreshMs = refreshMs;
    const previousProviders = configuredProviders;
    const previousDashboardOwnership = codexBarOwnershipState(config);
    config = { ...config, ...cloneValue(nextOptions) };
    enabled = parseBoolean(config.limitsEnabled ?? config.enabled, true);
    refreshMode = normalizeLimitsRefreshMode(config.limitsRefreshMode);
    refreshMs = refreshMode === 'adaptive'
      ? LIMITS_ADAPTIVE_BASE_MS
      : normalizeLimitsRefreshMs(config.limitsRefreshMs ?? config.refreshMs);
    configuredProviders = new Set(parseLimitProviders(config.limitProviders ?? config.providers));
    const nextDashboardOwnership = codexBarOwnershipState(config);
    const dashboardChanged = codexBarConfigChanged(
      previousDashboardOwnership,
      nextDashboardOwnership
    );
    const dashboardAffectedProviders = new Set([
      ...codexBarOwnedProviders(previousDashboardOwnership),
      ...codexBarOwnedProviders(nextDashboardOwnership)
    ]);

    if (dashboardChanged) {
      invalidateDashboardBatches('CodexBar configuration changed');
      for (const provider of dashboardAffectedProviders) {
        const lane = lanes.get(provider);
        if (!lane) continue;
        cancelLane(lane, 'CodexBar configuration changed');
        resetRetryPolicy(lane);
        lane.identities.clear();
        lane.accountRevisions.clear();
      }
    }

    for (const provider of previousProviders) {
      if (configuredProviders.has(provider)) continue;
      const lane = lanes.get(provider);
      if (lane) {
        cancelLane(lane, 'provider removed');
        resetRetryPolicy(lane);
        lane.identities.clear();
      }
      lanes.delete(provider);
    }

    if (!enabled) {
      if (!dashboardChanged) invalidateDashboardBatches('limits disabled');
      clearDashboardExpiryTimer();
      clearIntervalTimer();
      clearUrgencyTimer();
      if (resetTimer !== null) clearTimer(resetTimer);
      resetTimer = null;
      for (const lane of lanes.values()) {
        cancelLane(lane, 'limits disabled');
        resetRetryPolicy(lane);
        lane.identities.clear();
      }
      rebuildSnapshot();
      return getSnapshot();
    }

    const reconfigureBatch = createDashboardBatch();
    if (!previousEnabled && enabled) {
      for (const provider of configuredProviders) {
        void queueScope({ provider }, 'enabled', reconfigureBatch);
      }
      lastScheduledFullAt = now();
    } else {
      for (const provider of configuredProviders) {
        if (dashboardChanged && dashboardAffectedProviders.has(provider)) {
          void queueScope({ provider }, 'settings-change', reconfigureBatch);
        } else if (!previousProviders.has(provider)) {
          void queueScope({ provider }, 'provider-added', reconfigureBatch);
        }
      }
    }

    if (started) {
      const elapsed = lastScheduledFullAt ? Math.max(0, now() - lastScheduledFullAt) : 0;
      if (refreshMs !== previousRefreshMs && lastScheduledFullAt && elapsed >= refreshMs) {
        runScheduledFullRefresh();
      } else {
        scheduleInterval(lastScheduledFullAt ? Math.max(0, refreshMs - elapsed) : refreshMs);
      }
    }
    rebuildSnapshot();
    return getSnapshot();
  }

  function getSnapshot() {
    return cloneValue(snapshot);
  }

  function getDiagnostics() {
    const providers = [...configuredProviders].map((provider) => {
      const lane = lanes.get(provider);
      const identities = lane ? [...lane.identities.values()] : [];
      const attempts = identities
        .map((identity) => identity.lastAttempt)
        .filter(Boolean);
      const successful = identities
        .map((identity) => identity.lastGood)
        .filter(Boolean);
      const latestAttempt = attempts
        .map((attempt) => attempt.at)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      const latestSuccess = successful
        .map((row) => row.updatedAt)
        .filter(Boolean)
        .sort()
        .at(-1)
        || attempts
          .filter((attempt) => publicAttemptStatus(attempt.status) === 'ok')
          .map((attempt) => attempt.at)
          .filter(Boolean)
          .sort()
          .at(-1)
        || null;
      const latestFailure = attempts
        .filter((attempt) => publicAttemptStatus(attempt.status) !== 'ok')
        .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
        .at(-1);
      return {
        provider,
        configured: true,
        active: Boolean(lane?.active),
        pending: lane?.pending.size || 0,
        accountCount: identities.length,
        retryAttempt: lane?.retryAttempt || 0,
        retryAt: lane?.retryNotBefore > 0 ? new Date(lane.retryNotBefore).toISOString() : null,
        lastAttemptAt: latestAttempt,
        lastSuccessAt: latestSuccess,
        lastFailureCode: latestFailure
          ? latestFailure.code || publicAttemptStatus(latestFailure.status)
          : null
      };
    });
    return {
      enabled,
      active: executorActive,
      maxConcurrency,
      queued: providerQueue.length,
      providers
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function start() {
    if (started || stopped) return;
    started = true;
    if (!enabled) return;
    lastScheduledFullAt = now();
    void refresh({}, 'startup');
    scheduleInterval(refreshMs);
    scheduleResetTimer();
    scheduleUrgencyTimer();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    runtimeEpoch += 1;
    invalidateDashboardBatches('runtime stopped');
    clearDashboardExpiryTimer();
    clearIntervalTimer();
    clearUrgencyTimer();
    if (resetTimer !== null) clearTimer(resetTimer);
    resetTimer = null;
    for (const lane of lanes.values()) {
      cancelLane(lane, 'runtime stopped');
      resetRetryPolicy(lane);
    }
    providerQueue.length = 0;
    queuedProviders.clear();
    listeners.clear();
  }

  const initialDashboardOwnership = codexBarOwnershipState(config);
  for (const row of normalizeLimitsSummary(config.previousLimits || {}).providers) {
    if (!configuredProviders.has(row.provider)) continue;
    const dashboardOwned = initialDashboardOwnership.enabled
      && initialDashboardOwnership.providers.has(row.provider);
    if (dashboardOwned !== (row.producer === 'codexbar')) continue;
    const lane = laneFor(row.provider);
    const identityKey = rowIdentityKey(row);
    const at = row.updatedAt || new Date(now()).toISOString();
    if (TRANSIENT_STATUSES.has(row.status) && row.windows.length > 0) {
      lane.identities.set(identityKey, {
        identityKey,
        lastGood: normalizeLimitProvider({ ...row, status: 'ok' }),
        lastAttempt: { status: row.status, at, row }
      });
    } else {
      applyAttempt(lane, identityKey, row, row.status, at);
    }
  }
  rebuildSnapshot();
  if (deps.autoStart !== false) start();

  return {
    clear,
    getDiagnostics,
    getSnapshot,
    reconfigure,
    refresh,
    start,
    stop,
    subscribe
  };
}

module.exports = {
  DEFAULT_LIMITS_MAX_CONCURRENCY,
  TRANSIENT_STATUSES,
  accountIdentityPart,
  createLimitsRuntime,
  rowIdentityKey,
  scopeIdentityKey
};
