'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { buildCodexBarSummary } = require('../shared/codexbarSummary');

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 17322;
const SUMMARY_ROUTE = '/api/integrations/codexbar/v1/summary';

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function writeError(response, statusCode, code) {
  writeJson(response, statusCode, { error: { code } });
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match ? match[1] : '';
}

function tokenDigest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function authorized(request, expectedDigest) {
  const actualDigest = tokenDigest(bearerToken(request));
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function validPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65_535;
}

function createCodexBarSummaryServer(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (!token || token.length > 512) {
    throw new TypeError('A bounded, non-empty CodexBar summary token is required');
  }

  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  if (!validPort(port)) throw new TypeError('CodexBar summary port must be an integer');

  const getSnapshot = typeof options.getSnapshot === 'function'
    ? options.getSnapshot
    : options.getStats;
  if (typeof getSnapshot !== 'function') {
    throw new TypeError('A cache-only CodexBar summary snapshot reader is required');
  }

  const expectedDigest = tokenDigest(token);
  const logger = options.logger && typeof options.logger === 'object' ? options.logger : {};

  function logWarning(message) {
    try {
      if (typeof logger.warn === 'function') logger.warn(message);
    } catch (_) {}
  }

  async function handleRequest(request, response) {
    if (request.method !== 'GET' || request.url !== SUMMARY_ROUTE) {
      writeError(response, 404, 'not-found');
      return;
    }
    if (Object.hasOwn(request.headers, 'origin')) {
      writeError(response, 403, 'origin-not-allowed');
      return;
    }
    if (!authorized(request, expectedDigest)) {
      writeError(response, 401, 'unauthorized');
      return;
    }

    let snapshot;
    try {
      snapshot = await getSnapshot();
    } catch (_) {
      logWarning('CodexBar summary snapshot unavailable');
      writeError(response, 503, 'snapshot-unavailable');
      return;
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      writeError(response, 503, 'snapshot-unavailable');
      return;
    }

    try {
      const summary = buildCodexBarSummary(snapshot, {
        now: options.now,
        producerVersion: options.producerVersion
      });
      writeJson(response, 200, summary);
    } catch (_) {
      logWarning('CodexBar summary projection unavailable');
      writeError(response, 503, 'snapshot-unavailable');
    }
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (response.headersSent || response.destroyed) return;
      logWarning('CodexBar summary request unavailable');
      writeError(response, 503, 'snapshot-unavailable');
    });
  });

  let startPromise = null;
  let stopPromise = null;

  function start() {
    if (stopPromise) return stopPromise.then(() => start());
    if (server.listening) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
      function cleanup() {
        server.off('error', onError);
        server.off('listening', onListening);
      }
      function onError(error) {
        cleanup();
        reject(error);
      }
      function onListening() {
        cleanup();
        resolve();
      }
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, BIND_HOST);
      } catch (error) {
        cleanup();
        reject(error);
      }
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch (_) {
          return;
        }
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  return {
    bindHost: BIND_HOST,
    route: SUMMARY_ROUTE,
    server,
    start,
    stop
  };
}

module.exports = { createCodexBarSummaryServer };
