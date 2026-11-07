'use strict';
// Top-bar server info: public IP, OS, CPU (cores, load, usage), memory, root disk. Cheap reads of
// /proc and statfs; the public IP (behind NAT no interface carries it) is asked of Cloudflare's trace
// endpoint once an hour.
const fs = require('fs');
const os = require('os');

let egress = { ip: null, at: 0 };
async function publicIp() {
  if (Date.now() - egress.at < 3600_000 && egress.ip) return egress.ip;
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(i.address)) { egress = { ip: i.address, at: Date.now() }; return i.address; }
  try { const t = await (await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) })).text(); const m = /^ip=(.+)$/m.exec(t); if (m) egress = { ip: m[1].trim(), at: Date.now() }; } catch (_) {}
  return egress.ip;
}
function osName() { try { const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8')); return m ? m[1] : os.type(); } catch (_) { return os.type(); } }
let lastCpu = null;
function cpuUsage() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3] + (f[4] || 0), total = f.reduce((a, b) => a + b, 0);
    const prev = lastCpu; lastCpu = { idle, total };
    if (!prev || total === prev.total) return null;
    return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
  } catch (_) { return null; }
}
function memory() {
  try {
    const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, Number(String(v).trim().split(' ')[0]) * 1024]; }));
    return { total: m.MemTotal, used: m.MemTotal - (m.MemAvailable || m.MemFree) };
  } catch (_) { return { total: os.totalmem(), used: os.totalmem() - os.freemem() }; }
}
let cache = null, cacheAt = 0;
async function get() {
  if (cache && Date.now() - cacheAt < 10_000) return cache;
  const s = fs.statfsSync('/'), cpus = os.cpus();
  cache = {
    hostname: os.hostname(), ip: await publicIp(), os: osName(), kernel: os.release(),
    cpu: { cores: cpus.length, model: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(), load1: Math.round(os.loadavg()[0] * 100) / 100, usage: cpuUsage() },
    mem: memory(), disk: { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize },
    uptime: os.uptime(),
  };
  cacheAt = Date.now();
  return cache;
}
cpuUsage();   // baseline for the first delta
module.exports = { get };
