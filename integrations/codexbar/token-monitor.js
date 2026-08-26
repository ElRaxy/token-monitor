"use strict";

/* global defineProvider */

const SUMMARY_BASE_URL = "http://127.0.0.1:17322";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveAmountOrUnknown(value) {
  return value === null || (Number.isFinite(value) && value > 0);
}

function isUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return false;
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  return timestamp.toISOString() === canonical;
}

function hasValidPeriod(period) {
  return isPlainObject(period)
    && isSafeCount(period.totalTokens)
    && isPositiveAmountOrUnknown(period.costUsd);
}

function hasValidSummary(payload) {
  if (!isPlainObject(payload) || payload.schemaVersion !== 1) return false;
  if (!isUtcTimestamp(payload.generatedAt)) return false;
  if (!isPlainObject(payload.producer)) return false;
  if (payload.producer.id !== "token-monitor") return false;
  if (
    payload.producer.version !== null
    && (
      typeof payload.producer.version !== "string"
      || !/^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(payload.producer.version)
    )
  ) return false;
  if (!isPlainObject(payload.freshness)) return false;
  const hasObservation = payload.freshness.observedAt !== null
    || payload.freshness.ageSeconds !== null;
  if (hasObservation && !isUtcTimestamp(payload.freshness.observedAt)) return false;
  if (hasObservation && !isSafeCount(payload.freshness.ageSeconds)) return false;
  if (!isSafeCount(payload.freshness.sourceCount)) return false;
  if (!isSafeCount(payload.freshness.staleSourceCount)) return false;
  if (payload.freshness.staleSourceCount > payload.freshness.sourceCount) return false;
  if (!isPlainObject(payload.periods)) return false;
  return hasValidPeriod(payload.periods.today) && hasValidPeriod(payload.periods.month);
}

function formatTokenCount(ctx, value) {
  if (value >= 1000000) {
    return `${ctx.format.number(value / 1000000, { maximumFractionDigits: 2 })} M tokens`;
  }
  if (value >= 1000) {
    return `${ctx.format.number(value / 1000, { maximumFractionDigits: 1 })} k tokens`;
  }
  return `${ctx.format.number(value)} tokens`;
}

function periodRow(ctx, label, period) {
  const row = {
    label,
    value: formatTokenCount(ctx, period.totalTokens),
  };
  if (period.costUsd !== null) row.secondaryValue = ctx.format.usd(period.costUsd);
  return row;
}

function absoluteUtcLabel(timestamp) {
  return `${timestamp.slice(0, 19).replace("T", " ")} UTC`;
}

function freshnessRow(ctx, freshness) {
  const sourceWord = freshness.sourceCount === 1 ? "fuente" : "fuentes";
  const facts = [`${ctx.format.number(freshness.sourceCount)} ${sourceWord}`];
  if (freshness.staleSourceCount > 0) {
    facts.push(`${ctx.format.number(freshness.staleSourceCount)} stale`);
  }
  if (freshness.ageSeconds !== null) {
    facts.unshift(`${ctx.format.number(freshness.ageSeconds)} s`);
  }
  return {
    label: "Actualizado",
    value: freshness.observedAt === null
      ? "Sin marca temporal"
      : absoluteUtcLabel(freshness.observedAt),
    secondaryValue: facts.join(" · "),
  };
}

defineProvider({
  id: "token-monitor-bridge",
  name: "Token Monitor",
  icon: { monogram: "TM", tint: "#22C55E" },
  endpoints: [{ setting: "BASE_URL", policy: "https-or-private-network-http" }],
  auth: { type: "bearer", secret: "SUMMARY_TOKEN" },
  capabilities: ["http-status"],
  settings: [
    {
      key: "BASE_URL",
      title: "Token Monitor URL",
      subtitle: "Loopback summary endpoint, normally http://127.0.0.1:17322",
      type: "plain",
    },
    {
      key: "SUMMARY_TOKEN",
      title: "Summary token",
      subtitle: "Dedicated bearer copied from Token Monitor settings.",
      type: "secure",
    },
  ],
  async fetchUsage(ctx) {
    const configuredBaseUrl = ctx.settings.get("BASE_URL");
    if (typeof configuredBaseUrl !== "string" || configuredBaseUrl.trim().length === 0) {
      throw ctx.fail.providerUnavailable("Configure the Token Monitor loopback URL.");
    }

    const baseUrl = configuredBaseUrl.trim().replace(/\/+$/, "");
    if (baseUrl !== SUMMARY_BASE_URL) {
      throw ctx.fail.providerUnavailable(
        "Use the exact Token Monitor loopback URL: http://127.0.0.1:17322.",
      );
    }
    // Build options from the host context prototype so both CodexBar engines
    // receive a host-realm plain object instead of an engine-specific wrapper.
    const requestOptions = Object.create(Object.getPrototypeOf(ctx));
    requestOptions.timeoutSeconds = 2;
    const response = await ctx.http.getJSON(
      `${baseUrl}/api/integrations/codexbar/v1/summary`,
      requestOptions,
    );

    if (response.status === 401) {
      throw ctx.fail.authenticationExpired("Token Monitor rejected the summary token.");
    }
    if (response.status === 403) {
      throw ctx.fail.permissionDenied("Token Monitor rejected this request origin.");
    }
    if (response.status === 404) {
      throw ctx.fail.providerUnavailable("Token Monitor summary endpoint was not found.");
    }
    if (response.status === 503) {
      throw ctx.fail.providerUnavailable("Token Monitor has no summary snapshot yet.");
    }
    if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw ctx.fail.apiFailure("Token Monitor summary request failed.");
    }
    if (!hasValidSummary(response.json)) {
      throw ctx.fail.parseFailure("Token Monitor returned an invalid summary.");
    }

    const payload = response.json;
    return {
      details: [{
        title: "Resumen de uso",
        rows: [
          periodRow(ctx, "Hoy", payload.periods.today),
          periodRow(ctx, "Este mes", payload.periods.month),
          freshnessRow(ctx, payload.freshness),
        ],
      }],
    };
  },
});
