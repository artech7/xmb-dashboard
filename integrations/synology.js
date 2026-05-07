/**
 * Synology DSM Integration
 * Polls the DSM REST API and returns normalized live data.
 *
 * DSM API flow:
 *   1. POST /webapi/auth.cgi  →  get session SID
 *   2. GET  /webapi/entry.cgi  →  query any API using the SID
 *   3. GET  /webapi/auth.cgi?method=logout  →  clean up session
 *
 * We keep a persistent SID and only re-auth on 401 / session expiry.
 */

const https = require('https');
const http  = require('http');
const { URLSearchParams } = require('url');

// ─────────────────────────────────────────────────────────────────
// Thin HTTP helper (no deps beyond Node built-ins)
// ─────────────────────────────────────────────────────────────────
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const lib      = parsed.protocol === 'https:' ? https : http;
    const reqOpts  = {
      hostname : parsed.hostname,
      port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : opts.method || 'GET',
      headers  : opts.headers || {},
      // allow self-signed certs on local NAS
      rejectUnauthorized: false,
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
// SynologyClient
// ─────────────────────────────────────────────────────────────────
class SynologyClient {
  constructor(cfg) {
    // cfg: { host, port, user, password, https, name }
    this.cfg  = cfg;
    this.sid  = null;
    this.base = `${cfg.https ? 'https' : 'http'}://${cfg.host}:${cfg.port || (cfg.https ? 5001 : 5000)}`;
  }

  // Build a webapi URL with params
  _url(cgi, params) {
    const p = new URLSearchParams(params);
    if (this.sid) p.set('_sid', this.sid);
    return `${this.base}/webapi/${cgi}?${p.toString()}`;
  }

  async login() {
    const url = this._url('auth.cgi', {
      api     : 'SYNO.API.Auth',
      version : '7',
      method  : 'login',
      account : this.cfg.user,
      passwd  : this.cfg.password,
      session : 'homelab-xmb',
      format  : 'sid',
    });
    const { body } = await request(url);
    if (!body.success) throw new Error(`Synology auth failed: ${JSON.stringify(body.error)}`);
    this.sid = body.data.sid;
    return this.sid;
  }

  async logout() {
    if (!this.sid) return;
    await request(this._url('auth.cgi', {
      api: 'SYNO.API.Auth', version: '7', method: 'logout', session: 'homelab-xmb',
    })).catch(() => {});
    this.sid = null;
  }

  async query(api, method, version, extra = {}) {
    if (!this.sid) await this.login();
    const url = this._url('entry.cgi', { api, method, version, ...extra });
    const { body } = await request(url);
    // session expired → re-login once
    if (!body.success && body.error?.code === 119) {
      this.sid = null;
      await this.login();
      const { body: body2 } = await request(this._url('entry.cgi', { api, method, version, ...extra }));
      if (!body2.success) throw new Error(`Synology API error (${api}): ${JSON.stringify(body2.error)}`);
      return body2.data;
    }
    if (!body.success) throw new Error(`Synology API error (${api}): ${JSON.stringify(body.error)}`);
    return body.data;
  }

  // ── Convenience wrappers ──────────────────────────────────────

  async getSystemInfo() {
    return this.query('SYNO.Core.System', 'info', '1');
  }

  async getStorageInfo() {
    // Returns volumes[], disks[], spaceinfo
    return this.query('SYNO.Storage.CGI.Storage', 'load_info', '1');
  }

  async getResourceUsage() {
    // CPU, memory, network, disk I/O
    return this.query('SYNO.Core.System.Utilization', 'get', '1');
  }

  async getDSMInfo() {
    return this.query('SYNO.DSM.Info', 'getinfo', '2');
  }

  async getUpdateInfo() {
    return this.query('SYNO.DSM.Update.Server', 'getinfo', '1').catch(() => null);
  }

  async getSmartStatus() {
    return this.query('SYNO.Storage.CGI.Smart', 'load_info', '1').catch(() => null);
  }

  async getSharedFolders() {
    return this.query('SYNO.Core.Share', 'list', '1', {
      offset: 0, limit: 50, sort_by: 'name', sort_direction: 'ASC',
    }).catch(() => null);
  }
}

// ─────────────────────────────────────────────────────────────────
// Polling loop — returns a LiveData object keyed by metric name
// ─────────────────────────────────────────────────────────────────

function fmt(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

function fmtTB(bytes) {
  return (bytes / 1099511627776).toFixed(1) + ' TB';
}

function fmtPct(used, total) {
  if (!total) return '0%';
  return Math.round((used / total) * 100) + '%';
}

async function poll(client) {
  const results = { _ts: Date.now(), _name: client.cfg.name || client.cfg.host };

  await Promise.allSettled([
    client.getDSMInfo().then(d => {
      results.dsmVersion    = d.version_string || d.version || '—';
      results.uptime        = formatUptime(d.uptime_second || 0);
      results.hostname      = d.hostname || client.cfg.host;
      results.model         = d.model || '—';
    }),

    client.getSystemInfo().then(d => {
      results.cpuBrand      = d.cpu_vendor + ' ' + d.cpu_series;
      results.cpuCores      = d.cpu_cores;
      results.totalRam      = fmt(d.ram_size * 1024 * 1024);
      results.fans          = (d.sys_fan || []).map(f => f.status).join(', ') || 'OK';
      results.temperature   = d.temperature ? d.temperature + '°C' : null;
    }),

    client.getResourceUsage().then(d => {
      results.cpuPct        = (d.cpu?.user_load  ?? '?') + '%';
      results.cpuSystem     = (d.cpu?.system_load ?? '?') + '%';
      results.memUsed       = fmt((d.memory?.real_usage ?? 0) * 1024);
      results.memTotal      = fmt((d.memory?.total        ?? 0) * 1024);
      results.memPct        = (d.memory?.real_usage_pct  ?? '?') + '%';
      const net             = (d.network || [])[0] || {};
      results.netRx         = fmt((net.rx ?? 0)) + '/s';
      results.netTx         = fmt((net.tx ?? 0)) + '/s';
    }),

    client.getStorageInfo().then(d => {
      results.volumes = (d.volumes || []).map(v => ({
        id       : v.volume_id || v.id,
        label    : v.label || v.volume_id,
        status   : v.status,
        fs       : v.fs_type,
        used     : fmtTB(v.used_size_byte  || 0),
        total    : fmtTB(v.total_size_byte || 0),
        free     : fmtTB((v.total_size_byte || 0) - (v.used_size_byte || 0)),
        pct      : fmtPct(v.used_size_byte, v.total_size_byte),
        raid     : v.device_type || '—',
      }));

      results.diskCount   = (d.disks || []).length;
      results.disksFailed = (d.disks || []).filter(d => d.status !== 'normal').length;
      results.diskStatus  = results.disksFailed === 0 ? 'All OK' : `${results.disksFailed} issue(s)`;
    }),

    client.getUpdateInfo().then(d => {
      if (!d) { results.updateAvailable = false; return; }
      results.updateAvailable = d.available === true;
      results.updateVersion   = d.version || null;
    }),
  ]);

  return results;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ─────────────────────────────────────────────────────────────────
// Build dashboard item patches from live data
// Maps polled metrics → { categoryId, itemLabel, value, badge, badgeClass, detailRows }
// ─────────────────────────────────────────────────────────────────
function buildPatches(live) {
  const patches = [];

  // Main NAS item patch (goes into Storage or Servers category)
  patches.push({
    _target   : { label: live._name },   // match by label
    value     : live.volumes?.[0]
                  ? `${live.volumes[0].used} / ${live.volumes[0].total}`
                  : '—',
    badge     : live.disksFailed > 0 ? 'WARN' : 'OK',
    badgeClass: live.disksFailed > 0 ? 'warn' : 'ok',
    detail    : {
      title: live._name,
      rows : [
        ['Model',    live.model    || '—'],
        ['DSM',      live.dsmVersion || '—'],
        ['Uptime',   live.uptime   || '—'],
        ['CPU',      live.cpuPct   || '—'],
        ['RAM',      live.memPct ? `${live.memUsed} / ${live.memTotal} (${live.memPct})` : '—'],
        ['Net ↓',    live.netRx   || '—'],
        ['Net ↑',    live.netTx   || '—'],
        ['Disks',    live.diskStatus || '—'],
        ['Temp',     live.temperature || '—'],
        ...(live.volumes || []).map(v => [
          `Vol: ${v.label}`, `${v.used} / ${v.total} (${v.pct}) — ${v.status}`
        ]),
        ...(live.updateAvailable
          ? [['Update', live.updateVersion ? `${live.updateVersion} available` : 'Available']]
          : []),
      ],
    },
  });

  return patches;
}

module.exports = { SynologyClient, poll, buildPatches };
