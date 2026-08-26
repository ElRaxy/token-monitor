'use strict';

const PRODUCER_ID = 'token-monitor';
const PRODUCER_VERSION_PATTERN = /^[a-z0-9][a-z0-9.+_-]{0,63}$/i;

function validDateMs(value) {
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && value.trim() === '')
    || (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return null;
  }
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function generatedAtMs(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : Date.now();
  } catch (_) {
    value = Date.now();
  }
  const milliseconds = value instanceof Date ? value.getTime() : validDateMs(value);
  return milliseconds === null ? Date.now() : milliseconds;
}

function safeProducerVersion(value) {
  const version = typeof value === 'string' ? value.trim() : '';
  return PRODUCER_VERSION_PATTERN.test(version) ? version : null;
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function knownCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function sourceObservationMs(device, nowMs) {
  if (!device || typeof device !== 'object' || Array.isArray(device)) return null;

  const candidates = [validDateMs(device.receivedAt), validDateMs(device.updatedAt)]
    .filter((value) => value !== null);
  if (typeof device.ageMs === 'number' && Number.isFinite(device.ageMs) && device.ageMs >= 0) {
    const derivedObservation = validDateMs(nowMs - device.ageMs);
    if (derivedObservation !== null) candidates.push(derivedObservation);
  }
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function freshnessFromDevices(devices, nowMs) {
  const sources = Array.isArray(devices)
    ? devices.filter((device) => device && typeof device === 'object' && !Array.isArray(device))
    : [];
  let latestObservationMs = null;
  let staleSourceCount = 0;

  for (const device of sources) {
    if (device.stale === true) staleSourceCount += 1;
    const observationMs = sourceObservationMs(device, nowMs);
    if (
      observationMs !== null
      && (latestObservationMs === null || observationMs > latestObservationMs)
    ) {
      latestObservationMs = observationMs;
    }
  }

  return {
    observedAt: latestObservationMs === null ? null : new Date(latestObservationMs).toISOString(),
    ageSeconds: latestObservationMs === null
      ? null
      : Math.max(0, Math.floor((nowMs - latestObservationMs) / 1_000)),
    sourceCount: sources.length,
    staleSourceCount
  };
}

function projectPeriod(period) {
  const source = period && typeof period === 'object' && !Array.isArray(period)
    ? period
    : {};
  return {
    totalTokens: safeTokenCount(source.totalTokens),
    costUsd: knownCost(source.costUsd)
  };
}

function buildCodexBarSummary(stats, options = {}) {
  const source = stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
  const nowMs = generatedAtMs(options.now);
  const periods = source.periods && typeof source.periods === 'object'
    && !Array.isArray(source.periods)
    ? source.periods
    : {};

  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    producer: {
      id: PRODUCER_ID,
      version: safeProducerVersion(options.producerVersion)
    },
    freshness: freshnessFromDevices(source.devices, nowMs),
    periods: {
      today: projectPeriod(periods.today),
      month: projectPeriod(periods.month)
    }
  };
}

module.exports = { buildCodexBarSummary };
