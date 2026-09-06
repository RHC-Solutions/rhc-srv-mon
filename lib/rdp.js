'use strict';
// RDP in the browser. There is no pure-JS RDP client (and Debian ships no guacd), so each viewer gets
// its own throwaway X display on this server: Xvnc on a free loopback port + xfreerdp drawing into it.
// The browser then sees a normal VNC stream through the same /ws/vnc bridge machinery.
//
//   browser ──ws──► panel ──► Xvnc :N (loopback, random password) ◄── xfreerdp ──► target:3389
//
// The display is created when the viewer opens and torn down when it closes (or when either process
// exits), so nothing lingers. Everything binds to 127.0.0.1.
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const ssh = require('./ssh');
const vncPasswd = require('./vnc-passwd');

const DISPLAY_MIN = 60, DISPLAY_MAX = 99;      // :60–:99 are ours; real desktops live lower
const START_TIMEOUT_MS = 45_000;
const sessions = new Map();                    // display number -> live session
const recent = [];                             // the last few finished ones, so their log survives the teardown
const RECENT_MAX = 10;
function remember(sess) {
  recent.unshift({ display: sess.display, hostName: sess.hostName, target: sess.target, startedAt: sess.startedAt,
    endedAt: new Date().toISOString(), err: sess.err || null, log: (sess.log || []).slice(-200), finished: true });
  while (recent.length > RECENT_MAX) recent.pop();
}

function binaries() {
  const find = (n) => { try { return execFileSync('sh', ['-c', 'command -v ' + n + ' || true'], { encoding: 'utf8' }).trim(); } catch (_) { return ''; } };
  return { xvnc: find('Xvnc') || find('Xtigervnc'), rdp: find('xfreerdp3') || find('xfreerdp') };
}
function ready() {
  const b = binaries();
  if (!b.xvnc || !b.rdp) {
    return { ok: false, missing: [!b.xvnc && 'tigervnc-standalone-server', !b.rdp && 'freerdp3-x11'].filter(Boolean),
      hint: 'apt-get install -y --no-install-recommends ' + [!b.xvnc && 'tigervnc-standalone-server', !b.rdp && 'freerdp3-x11'].filter(Boolean).join(' ') };
  }
  return { ok: true, xvnc: b.xvnc, rdp: b.rdp };
}
function portFree(port) {
  try { execFileSync('sh', ['-c', 'ss -tln 2>/dev/null | grep -q ":' + port + ' "'], { stdio: 'ignore' }); return false; } catch (_) { return true; }
}
function freeDisplay() {
  for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) {
    if (sessions.has(n)) continue;
    if (fs.existsSync('/tmp/.X' + n + '-lock')) continue;
    if (!portFree(5900 + n)) continue;
    return n;
  }
  return null;
}
function targetOf(h) {
  return { host: h.rdpHost || h.host, port: Number(h.rdpPort) || 3389, tunnel: !!h.rdpTunnel,
    user: h.rdpUser || '', domain: h.rdpDomain || '', geometry: /^\d{3,5}x\d{3,5}$/.test(String(h.rdpGeometry || '')) ? h.rdpGeometry : '1280x800' };
}

// Start Xvnc + xfreerdp for this host and resolve once the RDP client has drawn something (or fail
// with what xfreerdp said, which is the only useful diagnostic for wrong credentials / no route).
function startSession(h, onLog) {
  return new Promise((resolve, reject) => {
    const r = ready();
    if (!r.ok) return reject(Object.assign(new Error('RDP needs ' + r.missing.join(' and ') + ' on this server — ' + r.hint), { status: 409 }));
    const n = freeDisplay();
    if (n === null) return reject(Object.assign(new Error('no free display for another RDP session'), { status: 503 }));
    const t = targetOf(h);
    const port = 5900 + n;
    const vncPw = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhc-rdp-'));
    const pwFile = path.join(dir, 'passwd');
    fs.writeFileSync(pwFile, vncPasswd.encodePasswd(vncPw), { mode: 0o600 });
    const [w, hgt] = t.geometry.split('x');
    const log = (m) => { try { onLog && onLog(m); } catch (_) {} };
    const sess = { display: n, port, vncPw, dir, host: h.id, hostName: h.name, target: t.host + ':' + t.port, startedAt: new Date().toISOString(), xvnc: null, rdp: null, err: '' };
    sessions.set(n, sess);

    const cleanup = () => {
      if (sessions.has(n)) remember(sess);
      sessions.delete(n);
      for (const p of [sess.rdp, sess.xvnc]) { try { if (p && !p.killed) p.kill('SIGTERM'); } catch (_) {} }
      setTimeout(() => { for (const p of [sess.rdp, sess.xvnc]) { try { if (p && !p.killed) p.kill('SIGKILL'); } catch (_) {} } }, 3000);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    };
    sess.cleanup = cleanup;

    sess.xvnc = spawn(r.xvnc, [':' + n, '-rfbport', String(port), '-rfbauth', pwFile, '-localhost', '-geometry', t.geometry,
      '-depth', '24', '-SecurityTypes', 'VncAuth', '-AlwaysShared', '-NeverShared=0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    sess.xvnc.stderr.on('data', (d) => log('Xvnc: ' + d.toString().trim().split('\n').pop()));
    sess.xvnc.on('exit', (code) => { if (sessions.has(n)) { log('Xvnc exited (' + code + ')'); cleanup(); } });

    // give Xvnc a moment to own the display, then attach the RDP client to it
    const t0 = Date.now();
    const startRdp = () => {
      const args = ['/v:' + t.host + ':' + t.port, '/size:' + w + 'x' + hgt, '/cert:ignore', '+clipboard', '/dynamic-resolution',
        '/log-level:INFO', '-grab-keyboard', '/bpp:24'];
      if (t.user) args.push('/u:' + t.user);
      if (t.domain) args.push('/d:' + t.domain);
      if (h.rdpSecurity && h.rdpSecurity !== 'auto') args.push('/sec:' + h.rdpSecurity);
      const env = Object.assign({}, process.env, { DISPLAY: ':' + n, HOME: dir });
      if (h.rdpPassword) env.FREERDP_PASSWORD = h.rdpPassword;
      sess.rdp = spawn(r.rdp, args.concat(h.rdpPassword ? ['/from-stdin'] : []), { env, stdio: ['pipe', 'pipe', 'pipe'] });
      if (h.rdpPassword) { try { sess.rdp.stdin.write(h.rdpPassword + '\n'); sess.rdp.stdin.end(); } catch (_) {} }
      let out = '';
      const grab = (d) => { const s2 = d.toString(); out += s2.slice(0, 4000); for (const l of s2.split('\n')) if (l.trim()) log('rdp: ' + l.trim().slice(0, 300)); };
      sess.rdp.stdout.on('data', grab); sess.rdp.stderr.on('data', grab);
      sess.rdp.on('exit', (code) => {
        if (!sessions.has(n)) return;
        const why = /ERRCONNECT_[A-Z_]+|Authentication failure|LOGON_FAILURE|failed to connect/i.exec(out);
        sess.err = 'the RDP client exited (' + code + ')' + (why ? ': ' + why[0] : '');
        log(sess.err); cleanup();
      });
      // the viewer can attach as soon as Xvnc listens; RDP failures surface as an empty desktop + log
      resolve(sess);
    };
    const wait = setInterval(() => {
      if (!sessions.has(n)) { clearInterval(wait); return reject(new Error('the X server exited before it was ready')); }
      if (!portFree(port)) { clearInterval(wait); log('display :' + n + ' ready on 127.0.0.1:' + port); startRdp(); return; }
      if (Date.now() - t0 > START_TIMEOUT_MS) { clearInterval(wait); cleanup(); reject(new Error('the X server did not start in time')); }
    }, 300);
  });
}

// A VNC-shaped host record pointing at the local display, for the existing bridge/probe.
function localHostFor(sess) {
  return { id: 'rdp:' + sess.display, name: sess.hostName, protocol: 'vnc', vncHost: '127.0.0.1', vncPort: sess.port, vncTunnel: false, vncPassword: sess.vncPw };
}
function get(display) { return sessions.get(Number(display)) || null; }
// the log of a live session, or of one that has just ended (why it ended is the interesting part)
function logOf(display) { return sessions.get(Number(display)) || recent.find((r) => r.display === Number(display)) || null; }
function list() { return [...sessions.values()].map((s) => ({ display: s.display, port: s.port, host: s.hostName, target: s.target, startedAt: s.startedAt })); }
function stop(display) { const s = sessions.get(Number(display)); if (s) { s.cleanup(); return true; } return false; }
function stopAll() { for (const s of [...sessions.values()]) s.cleanup(); }

module.exports = { ready, startSession, localHostFor, get, logOf, list, stop, stopAll, targetOf, sessions };
