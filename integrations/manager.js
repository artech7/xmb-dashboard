/**
 * Integration manager
 * Reads integrations.json, spins up pollers, and maintains a live-data store
 * that server.js exposes via GET /api/live
 */

const fs   = require('fs');
const path = require('path');

const { SynologyClient, poll: synoPoll, buildPatches: synoPatches } = require('./synology');

const INTEGRATIONS_FILE = process.env.INTEGRATIONS_PATH
  || path.join(__dirname, '..', 'integrations.json');

// ── In-memory live data store ──────────────────────────────────
const liveStore = {
  // keyed by integration id
  // { id, type, status, lastPoll, error, data, patches }
};

// ── Load integrations config ───────────────────────────────────
function loadIntegrations() {
  try {
    if (!fs.existsSync(INTEGRATIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf8'));
  } catch (e) {
    console.warn('[integrations] Failed to read integrations.json:', e.message);
    return [];
  }
}

function saveIntegrations(list) {
  fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ── Poller registry ────────────────────────────────────────────
const pollerTimers = {};

function startPoller(integration) {
  const id       = integration.id;
  const interval = (integration.pollInterval || 30) * 1000;

  // Stop any existing timer for this id
  stopPoller(id);

  async function run() {
    liveStore[id] = { ...liveStore[id], id, type: integration.type, status: 'polling' };
    try {
      let data = null, patches = [];

      if (integration.type === 'synology') {
        const client = new SynologyClient(integration.config);
        data    = await synoPoll(client);
        patches = synoPatches(data);
        await client.logout().catch(() => {});
      }
      // Future: add more integration types here

      liveStore[id] = {
        id, type: integration.type,
        status  : 'ok',
        lastPoll: new Date().toISOString(),
        error   : null,
        name    : integration.name || integration.config?.host || id,
        data,
        patches,
      };
      console.log(`[integrations] ✓ ${id} polled OK`);
    } catch (e) {
      liveStore[id] = {
        ...liveStore[id],
        status  : 'error',
        lastPoll: new Date().toISOString(),
        error   : e.message,
      };
      console.warn(`[integrations] ✗ ${id} poll error:`, e.message);
    }
  }

  // Run immediately, then on interval
  run();
  pollerTimers[id] = setInterval(run, interval);
}

function stopPoller(id) {
  if (pollerTimers[id]) {
    clearInterval(pollerTimers[id]);
    delete pollerTimers[id];
  }
}

// ── Start all enabled integrations ────────────────────────────
function startAll() {
  const list = loadIntegrations();
  list.filter(i => i.enabled !== false).forEach(startPoller);
  console.log(`[integrations] Started ${list.length} integration(s)`);
}

// ── Manual trigger (for the "Test" button in settings) ────────
async function triggerPoll(id) {
  const list = loadIntegrations();
  const integration = list.find(i => i.id === id);
  if (!integration) throw new Error(`Integration "${id}" not found`);

  liveStore[id] = { ...liveStore[id], status: 'polling' };
  try {
    let data = null, patches = [];
    if (integration.type === 'synology') {
      const client = new SynologyClient(integration.config);
      data    = await synoPoll(client);
      patches = synoPatches(data);
      await client.logout().catch(() => {});
    }
    liveStore[id] = {
      id, type: integration.type, status: 'ok',
      lastPoll: new Date().toISOString(), error: null,
      name: integration.name || id, data, patches,
    };
    return liveStore[id];
  } catch (e) {
    liveStore[id] = { ...liveStore[id], status: 'error', error: e.message };
    throw e;
  }
}

module.exports = {
  liveStore,
  loadIntegrations,
  saveIntegrations,
  startAll,
  startPoller,
  stopPoller,
  triggerPoll,
};
