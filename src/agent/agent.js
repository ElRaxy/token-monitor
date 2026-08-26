'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultDeviceId, loadDotEnv, parseArgs, pidFilePath } = require('../shared/config');
const { appVersion } = require('../shared/appVersion');
const { clientsCsvForSetting } = require('../shared/clientTracking');
const { normalizeCodexBarConfig } = require('../shared/codexbarConfig');
const { normalizeHistoryIntervalMs } = require('../shared/collector');
const {
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  parseBoolean,
  parseLimitProviders
} = require('../shared/limitCollector');
const { postSyncPayload } = require('../shared/syncPayload');
const { applyProjectRollups } = require('../shared/usage');
const { runAgent, runAgentOnce } = require('./runtime');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('../shared/sessionUsageArchive');

function buildAgentConfiguration(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const argv = Array.isArray(options.argv) ? options.argv : [];
  const args = parseArgs(argv);
  const hubUrl = String(args.hub || args.hubUrl || env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321').replace(/\/$/, '');
  const secret = String(args.secret || env.TOKEN_MONITOR_SECRET || '').trim();
  const deviceId = String(args.device || args.deviceId || env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId());
  const intervalMs = Number(args.interval || args.intervalMs || env.TOKEN_MONITOR_INTERVAL_MS || 5 * 60 * 1000);
  const watchEnabled = String(args.watch ?? env.TOKEN_MONITOR_WATCH ?? '1') !== '0';
  const watchDebounceMs = Number(args.watchDebounceMs || env.TOKEN_MONITOR_WATCH_DEBOUNCE_MS || 1500);
  const clients = clientsCsvForSetting(args.clients ?? env.TOKEN_MONITOR_CLIENTS);
  const allTimeSince = String(args.since || args.allTimeSince || env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01');
  const commandTimeoutMs = Number(args.timeoutMs || env.TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS || 120 * 1000);
  const limitsEnabled = parseBoolean(args.limits ?? args.limitsEnabled ?? env.TOKEN_MONITOR_LIMITS_ENABLED, true);
  const limitProviders = parseLimitProviders(args.limitProviders ?? env.TOKEN_MONITOR_LIMIT_PROVIDERS).join(',');
  const limitsRefreshMs = normalizeLimitsRefreshMs(args.limitsRefreshMs || env.TOKEN_MONITOR_LIMITS_REFRESH_MS);
  const limitsRefreshMode = normalizeLimitsRefreshMode(args.limitsRefreshMode || env.TOKEN_MONITOR_LIMITS_REFRESH_MODE);
  const historyEnabled = parseBoolean(args.history ?? args.historyEnabled ?? env.TOKEN_MONITOR_HISTORY_ENABLED, true);
  const projectsEnabled = parseBoolean(args.projects ?? args.projectsEnabled ?? env.TOKEN_MONITOR_PROJECTS_ENABLED, false);
  const sessionUsageArchiveEnabled = parseBoolean(args.sessionArchive ?? args.sessionUsageArchiveEnabled ?? env.TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED, true);
  const wslScanEnabled = parseBoolean(args.wslScan ?? args.wslScanEnabled ?? env.TOKEN_MONITOR_WSL_SCAN, true);
  const opencodeLocalLimitsEnabled = parseBoolean(
    args['opencode-local-limits']
      ?? args.opencodeLocalLimits
      ?? args.opencodeLocalLimitsEnabled
      ?? env.TOKEN_MONITOR_OPENCODE_LOCAL_LIMITS,
    false
  );
  // The key OpenCode stores for itself needs no configuration, so an unattended
  // agent reports it by default. Switched off for a machine signed in to an
  // account whose quota should not leave it. The widget resolves the same setting
  // through settings.json; here it is env or flag, like every other agent option.
  const opencodeAmbientEnv = env === process.env
    ? process.env.TOKEN_MONITOR_OPENCODE_AMBIENT
    : env.TOKEN_MONITOR_OPENCODE_AMBIENT;
  const opencodeAmbientEnabled = parseBoolean(
    args['opencode-ambient']
      ?? args.opencodeAmbient
      ?? args.opencodeAmbientEnabled
      ?? opencodeAmbientEnv,
    true
  );
  const opencodeCookie = String(env.TOKEN_MONITOR_OPENCODE_COOKIE || '').trim();
  const once = Boolean(args.once);
  const dryRun = Boolean(args['dry-run'] || args.dryRun);
  const agentVersion = appVersion();
  const codexbarConfigured = [
    'TOKEN_MONITOR_CODEXBAR_URL',
    'TOKEN_MONITOR_CODEXBAR_TOKEN',
    'TOKEN_MONITOR_CODEXBAR_PROVIDERS'
  ].some((key) => String(env[key] || '').trim().length > 0);
  const codexbarConfig = normalizeCodexBarConfig({
    codexbarDashboardEnabled: codexbarConfigured,
    codexbarDashboardUrl: env.TOKEN_MONITOR_CODEXBAR_URL,
    codexbarDashboardToken: env.TOKEN_MONITOR_CODEXBAR_TOKEN,
    codexbarDelegatedProviders: env.TOKEN_MONITOR_CODEXBAR_PROVIDERS
  });

  const usageOptions = {
    clients,
    allTimeSince,
    commandTimeoutMs,
    deviceId,
    agentVersion,
    agentRuntime: 'headless-agent',
    projectsEnabled,
    historyEnabled,
    historyIntervalMs: normalizeHistoryIntervalMs(env.TOKEN_MONITOR_HISTORY_INTERVAL_MS),
    dailyHistoryArchiveEnabled: sessionUsageArchiveEnabled,
    dailyHistoryArchiveWriteEnabled: !dryRun,
    anchorPersistenceEnabled: !once && !dryRun,
    intervalMs,
    watchEnabled,
    watchDebounceMs,
    wslScanEnabled,
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`),
    logger: (message) => (dryRun ? console.error(message) : console.log(message))
  };
const limitsOptions = {
  limitsEnabled,
  limitProviders,
  limitsRefreshMode,
  limitsRefreshMs,
  claudeWebCookie: '',
  opencodeLocalLimitsEnabled,
  opencodeAmbientEnabled,
  opencodeCookie,
  ...codexbarConfig
};
  return {
    allTimeSince,
    deviceId,
    dryRun,
    historyEnabled,
    hubUrl,
    intervalMs,
    limitProviders,
    limitsEnabled,
    limitsOptions,
    limitsRefreshMode,
    limitsRefreshMs,
    once,
    projectsEnabled,
    secret,
    sessionUsageArchiveEnabled,
    usageOptions,
    watchEnabled
  };
}

let sessionUsageArchive;

function summaryWithSessionUsageArchive(summary, configuration, now = new Date()) {
  let visibleSummary = summary;
  if (configuration.sessionUsageArchiveEnabled) {
    const archiveDate = sessionUsageArchiveDate(summary, now);
    const previous = sessionUsageArchive || readSessionUsageArchive();
    const next = captureSessionUsageArchive(previous, summary, archiveDate);
    if (!configuration.dryRun && JSON.stringify(next) !== JSON.stringify(previous)) {
      try {
        writeSessionUsageArchive(next);
        sessionUsageArchive = next;
      } catch (error) {
        console.error(`[session-archive] write failed: ${error.message}`);
      }
    } else if (!configuration.dryRun) {
      sessionUsageArchive = next;
    }
    visibleSummary = applySessionUsageArchive(summary, next, { now: archiveDate });
  }
  return configuration.projectsEnabled ? applyProjectRollups(visibleSummary) : visibleSummary;
}

async function postUsage(summary, configuration) {
  const { response } = await postSyncPayload(fetch, `${configuration.hubUrl}/api/ingest`, {
    headers: {
      'content-type': 'application/json',
      ...(configuration.secret ? { authorization: `Bearer ${configuration.secret}` } : {})
    },
    summary,
    logger: (message) => console.warn(`[sync] ${message}`)
  });
  if (!response.ok) throw new Error(`Hub responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function deliver(summary, configuration) {
  if (configuration.dryRun) { console.log(JSON.stringify(summary, null, 2)); return; }
  await postUsage(summary, configuration);
  console.log(`[${new Date().toISOString()}] posted ${summary.deviceId}: today=${summary.today.totalTokens} month=${summary.month.totalTokens} allTime=${summary.allTime.totalTokens}`);
}

function registerPidFile(stopRuntime) {
  const pidPath = pidFilePath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(pidPath); } catch (_) {} };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { stopRuntime?.(); } catch (_) {}
      cleanup();
      process.exit(0);
    });
  }
}

async function main(configuration) {
  const {
    deviceId,
    dryRun,
    historyEnabled,
    hubUrl,
    intervalMs,
    limitProviders,
    limitsEnabled,
    limitsOptions,
    limitsRefreshMode,
    limitsRefreshMs,
    once,
    projectsEnabled,
    secret,
    sessionUsageArchiveEnabled,
    usageOptions,
    watchEnabled
  } = configuration;
  const startupMessage = `Token Monitor agent device=${deviceId} hub=${hubUrl} intervalMs=${intervalMs} watch=${watchEnabled} projects=${projectsEnabled ? 'on' : 'off'} history=${historyEnabled ? 'on' : 'off'} sessionArchive=${sessionUsageArchiveEnabled ? 'on' : 'off'} limits=${limitsEnabled ? `${limitProviders || 'none'}:${limitsRefreshMode === 'adaptive' ? 'adaptive' : `${limitsRefreshMs}ms`}` : 'off'}`;
  if (dryRun) console.error(startupMessage);
  else console.log(startupMessage);
  if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. Posting without authorization header.');
  // Claim archive ownership before either a one-shot or long-running scan so
  // Electron can yield before its history read-modify-write reaches disk.
  let runtimeHandle = null;
  if (!dryRun) registerPidFile(() => runtimeHandle?.stop());
  const runtimeOptions = {
    envelope: { deviceId, agentVersion: usageOptions.agentVersion, agentRuntime: 'headless-agent' },
    usageOptions,
    limitsOptions,
    transformUsage: (summary) => summaryWithSessionUsageArchive(summary, configuration),
    deliver: (summary) => deliver(summary, configuration),
    dryRun,
    onRuntime: (runtime) => { runtimeHandle = runtime; },
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`)
  };
  if (once) {
    await runAgentOnce(runtimeOptions);
    return;
  }
  runtimeHandle = runAgent(runtimeOptions);
}

if (require.main === module) {
  loadDotEnv();
  let configuration;
  try {
    configuration = buildAgentConfiguration({ env: process.env, argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (configuration) {
    main(configuration).catch((error) => { console.error(error); process.exitCode = 1; });
  }
}

module.exports = { buildAgentConfiguration };
