'use strict';
/* -------------------------------------------------------------------- ssh */
// SSH client (multi-tab terminal in the browser) + remote installer.
// Dependency-free: the terminal is xterm.js (loaded from a CDN by the page),
// the transport is a minimal RFC 6455 WebSocket implementation below, and the
// PTY is a small python3 helper (`pty.fork` + `ssh`) written to .helpers/ at
// startup. Password auth for interactive sessions is answered by the helper on
// the ssh prompt; for non-interactive jobs (test / install) it goes through
// SSH_ASKPASS (OpenSSH >= 8.4, SSH_ASKPASS_REQUIRE=force) so plain pipes work.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { APP_ROOT, PORT } = require('./config');
const { clientIp, authJson } = require('./http');
const updates = require('./updates');
const modules = require('./modules');
const backups = require('./backups');
const auth = require('./auth');

const SSH_FILE = path.join(APP_ROOT, 'ssh-hosts.json');   // gitignored (contains passwords)
const SSH_HELPER_DIR = path.join(APP_ROOT, '.helpers');
const SSH_PTY_HELPER = path.join(SSH_HELPER_DIR, 'ssh-pty.py');
const SSH_ASKPASS_HELPER = path.join(SSH_HELPER_DIR, 'ssh-askpass.sh');
const SSH_INSTALL_LOG_MAX = 30;
const SSH_JOB_LOG_MAX = 600;
const WS_MAX_BUFFER = 4 * 1024 * 1024;
const WS_PING_MS = 30_000;                 // keepalive ping interval (Cloudflare idle cutoff is ~100 s)
const WS_IDLE_DEAD_MS = 120_000;           // nothing heard from the browser for this long -> transport is dead
const SSH_DETACH_GRACE_MS = 0;             // 0 = detached sessions live until closed from the UI (tmux-like); >0 = ms grace
const SSH_SCROLLBACK_BYTES = 512 * 1024;   // rolling output history per session, replayed to the browser on (re-)attach
const SSH_UPLOAD_MAX = 200 * 1024 * 1024;  // file / image dropped or pasted into a terminal

let sshCache = { hosts: [], installLog: [] };
const sshSessions = new Map();     // sessionId -> { id, hostId, label, startedAt, child, socket }
const sshInstallJobs = new Map();  // jobId -> job (in-memory, full log)

const SSH_PTY_HELPER_SRC = `#!/usr/bin/env python3
# rhc-srv-mon pty daemon: runs argv[2:] (ssh ...) under a pty and serves it on the unix socket
# argv[1]. Double-forks into its own session so it survives restarts of the manager (pm2 tree-kill
# never sees it); the manager re-adopts it from .sessions/<id>.json. Keeps a rolling output history
# that is replayed to every new manager connection.
# Frames both ways: 1 byte type + 4 byte big-endian length + payload
#   manager -> daemon: 0 keystrokes, 2 control JSON ({"resize":[cols,rows]} | {"close":1})
#   daemon -> manager: 4 history (on connect), 1 live output, 3 exit JSON ({"code":n})
import os, sys, pty, select, termios, struct, fcntl, json, time, signal, socket

sock_path = sys.argv[1]
meta_path = sock_path[:-5] + '.json'
cols = int(os.environ.get('RHC_PTY_COLS', '120') or 120)
rows = int(os.environ.get('RHC_PTY_ROWS', '32') or 32)
password = os.environ.pop('RHC_SSH_PASSWORD', None)
HIST_MAX = 512 * 1024

if os.fork() != 0: os._exit(0)
os.setsid()
if os.fork() != 0: os._exit(0)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
try: os.chdir('/')
except OSError: pass
devnull = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2): os.dup2(devnull, fd)

try: os.unlink(sock_path)
except OSError: pass
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path); os.chmod(sock_path, 0o600); srv.listen(1); srv.setblocking(False)

def set_size(fd, r, c):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError: pass

pid, master = pty.fork()
if pid == 0:
    # the daemon ignores HUP/INT; ssh must not inherit that or a hangup would never end the session
    signal.signal(signal.SIGHUP, signal.SIG_DFL); signal.signal(signal.SIGINT, signal.SIG_DFL)
    try: os.execvp(sys.argv[2], sys.argv[2:])
    except Exception as e:
        sys.stderr.write('exec failed: %s\\n' % e); os._exit(127)
set_size(master, rows, cols)
try:
    m = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    m.update({'pid': os.getpid(), 'sshPid': pid})
    json.dump(m, open(meta_path, 'w'))
except Exception: pass

hist = bytearray(); client = None; cbuf = b''
recent = b''; pw_tries = 0; user_typed = False; t0 = time.time(); status = 0; closing_t0 = None

def frame(t, payload): return bytes([t]) + struct.pack('>I', len(payload)) + payload
def send(t, payload):
    global client
    if client is None: return
    try: client.sendall(frame(t, payload))
    except OSError:
        try: client.close()
        except OSError: pass
        client = None

while True:
    fds = [master, srv] + ([client] if client is not None else [])
    try: r, _, _ = select.select(fds, [], [], 0.5)
    except InterruptedError: continue
    if srv in r:
        try:
            c, _ = srv.accept(); c.setblocking(True)
            if client is not None:
                try: client.close()
                except OSError: pass
            client = c; cbuf = b''
            send(4, bytes(hist))
        except OSError: pass
    if master in r:
        try: data = os.read(master, 65536)
        except OSError: data = b''
        if not data: break
        hist += data
        if len(hist) > HIST_MAX: del hist[:len(hist) - HIST_MAX]
        send(1, data)
        if password and not user_typed and pw_tries < 2 and time.time() - t0 < 90:
            recent = (recent + data)[-256:]
            if b'assword:' in recent:
                os.write(master, password.encode() + b'\\n'); pw_tries += 1; recent = b''
    if client is not None and client in r:
        try: d = client.recv(65536)
        except OSError: d = b''
        if not d:
            try: client.close()
            except OSError: pass
            client = None
        else:
            cbuf += d
            while len(cbuf) >= 5:
                t = cbuf[0]; n = struct.unpack('>I', cbuf[1:5])[0]
                if len(cbuf) < 5 + n: break
                payload = cbuf[5:5 + n]; cbuf = cbuf[5 + n:]
                if t == 0:
                    user_typed = True
                    try: os.write(master, payload)
                    except OSError: pass
                elif t == 2:
                    try: m = json.loads(payload.decode() or '{}')
                    except Exception: m = {}
                    if 'resize' in m:
                        try:
                            set_size(master, int(m['resize'][1]), int(m['resize'][0])); os.kill(pid, signal.SIGWINCH)
                        except Exception: pass
                    if m.get('close'):
                        closing_t0 = closing_t0 or time.time()
                        try: os.kill(pid, signal.SIGHUP)
                        except OSError: pass
    if closing_t0 and time.time() - closing_t0 > 3:
        try: os.kill(pid, signal.SIGKILL)
        except OSError: pass
    try:
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid:
            status = st
            while True:
                try:
                    rr, _, _ = select.select([master], [], [], 0.05)
                    if master not in rr: break
                    data = os.read(master, 65536)
                    if not data: break
                    hist += data; send(1, data)
                except OSError: break
            break
    except ChildProcessError: break
try: os.close(master)
except OSError: pass
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0)
send(3, json.dumps({'code': code}).encode())
time.sleep(0.2)
try:
    if client is not None: client.close()
except OSError: pass
for pth in (sock_path, meta_path):
    try: os.unlink(pth)
    except OSError: pass
sys.exit(code)
`;

const SSH_ASKPASS_SRC = `#!/bin/sh
# rhc-srv-mon: SSH_ASKPASS helper for non-interactive jobs. Prints the password
# stored in the mode-600 file named by RHC_SSH_PW_FILE.
[ -n "$RHC_SSH_PW_FILE" ] && cat "$RHC_SSH_PW_FILE"
`;

function ensureSshHelpers() {
  try {
    fs.mkdirSync(SSH_HELPER_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(SSH_HELPER_DIR, 0o700);
    for (const [file, src] of [[SSH_PTY_HELPER, SSH_PTY_HELPER_SRC], [SSH_ASKPASS_HELPER, SSH_ASKPASS_SRC]]) {
      let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
      if (cur !== src) fs.writeFileSync(file, src, { mode: 0o700 });
      fs.chmodSync(file, 0o700);
    }
  } catch (e) { console.error('ssh helpers setup failed:', e.message); }
}

function loadSsh() {
  try {
    const data = JSON.parse(fs.readFileSync(SSH_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      sshCache.hosts = Array.isArray(data.hosts) ? data.hosts : [];
      // A persisted entry can never still be running: the process that ran it died with the previous
      // panel. Left as 'running' it is immortal — the clear and the per-entry delete both spare
      // anything marked running, so an install interrupted by a restart could never be removed.
      sshCache.installLog = (Array.isArray(data.installLog) ? data.installLog : []).map((j) =>
        (j && j.status === 'running'
          ? Object.assign({}, j, { status: 'interrupted', finishedAt: j.finishedAt || new Date().toISOString(), error: j.error || 'the panel restarted while this install was running; its outcome is unknown' })
          : j));
    }
  } catch (_) { /* first run */ }
}
function saveSsh() {
  try {
    fs.writeFileSync(SSH_FILE + '.tmp', JSON.stringify(sshCache, null, 2), { mode: 0o600 });
    fs.renameSync(SSH_FILE + '.tmp', SSH_FILE);
    fs.chmodSync(SSH_FILE, 0o600);
  } catch (e) { console.error('saveSsh failed:', e.message); }
}

function sshPublicHost(h) {
  const o = Object.assign({}, h);
  delete o.password; delete o.vncPassword; delete o.rdpPassword;
  o.hasPassword = !!h.password;
  o.hasVncPassword = !!h.vncPassword;
  o.hasRdpPassword = !!h.rdpPassword;
  return o;
}
function sshFindHost(id) { return sshCache.hosts.find((h) => h.id === id) || null; }

const SSH_HOST_RE = /^[A-Za-z0-9._:\-\[\]%]+$/;      // hostname / IPv4 / IPv6
const SSH_USER_RE = /^[A-Za-z0-9._\-]{1,64}$/;
function sshSanitizeHost(input, existing) {
  const h = Object.assign({}, existing || {});
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  if ('name' in input) h.name = str(input.name, 80);
  if ('group' in input) h.group = str(input.group, 60);
  if ('host' in input) h.host = str(input.host, 253);
  if ('user' in input) h.user = str(input.user, 64) || 'root';
  if ('port' in input) h.port = Math.max(1, Math.min(65535, parseInt(input.port) || 22));
  if ('auth' in input) h.auth = input.auth === 'password' ? 'password' : 'key';
  if ('identityFile' in input) h.identityFile = str(input.identityFile, 300);
  if ('notes' in input) h.notes = str(input.notes, 2000);
  if ('color' in input) h.color = str(input.color, 16);
  if ('becomeRoot' in input) h.becomeRoot = !!input.becomeRoot;
  if ('protocol' in input) h.protocol = ['ssh', 'vnc', 'rdp'].includes(input.protocol) ? input.protocol : 'ssh';
  if ('vncHost' in input) h.vncHost = str(input.vncHost, 253);
  if ('vncPort' in input) h.vncPort = Math.max(1, Math.min(65535, parseInt(input.vncPort) || 5901));
  if ('vncViewOnly' in input) h.vncViewOnly = !!input.vncViewOnly;
  if ('vncTunnel' in input) h.vncTunnel = input.vncTunnel !== false;   // reach the VNC port through ssh (default)
  if (typeof input.vncPassword === 'string' && input.vncPassword !== '') h.vncPassword = input.vncPassword.slice(0, 256);
  if (input.clearVncPassword) delete h.vncPassword;
  if ('rdpHost' in input) h.rdpHost = str(input.rdpHost, 253);
  if ('rdpPort' in input) h.rdpPort = Math.max(1, Math.min(65535, parseInt(input.rdpPort) || 3389));
  if ('rdpUser' in input) h.rdpUser = str(input.rdpUser, 128);
  if ('rdpDomain' in input) h.rdpDomain = str(input.rdpDomain, 128);
  if ('rdpGeometry' in input) h.rdpGeometry = /^\d{3,5}x\d{3,5}$/.test(String(input.rdpGeometry || '')) ? String(input.rdpGeometry) : '1280x800';
  if ('rdpSecurity' in input) h.rdpSecurity = ['auto', 'nla', 'tls', 'rdp'].includes(input.rdpSecurity) ? input.rdpSecurity : 'auto';
  if (typeof input.rdpPassword === 'string' && input.rdpPassword !== '') h.rdpPassword = input.rdpPassword.slice(0, 256);
  if (input.clearRdpPassword) delete h.rdpPassword;
  if (typeof input.password === 'string' && input.password !== '') h.password = input.password.slice(0, 256);
  if (input.clearPassword) delete h.password;
  if (!h.host || !SSH_HOST_RE.test(h.host)) throw new Error('Invalid host');
  if (!SSH_USER_RE.test(h.user || 'root')) throw new Error('Invalid user');
  if (h.identityFile && !/^[\w./~\-]+$/.test(h.identityFile)) throw new Error('Invalid identity file path');
  if (!h.name) h.name = (h.user ? h.user + '@' : '') + h.host;
  if (!h.port) h.port = 22;
  if (!h.auth) h.auth = 'key';
  if (!h.protocol) h.protocol = 'ssh';
  if (h.protocol === 'rdp') {
    if (!h.rdpPort) h.rdpPort = 3389;
    if (!h.rdpGeometry) h.rdpGeometry = '1280x800';
    if (h.rdpHost && !SSH_HOST_RE.test(h.rdpHost)) throw new Error('Invalid RDP host');
  }
  if (h.protocol === 'vnc') {
    if (!h.vncPort) h.vncPort = 5901;
    if (h.vncHost && !SSH_HOST_RE.test(h.vncHost)) throw new Error('Invalid VNC host');
    if (h.vncTunnel === undefined) h.vncTunnel = true;
  }
  return h;
}

// Common ssh CLI options. `batch` = non-interactive job (test / install).
function sshBaseArgs(h, batch) {
  const a = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30',
             '-o', 'ServerAliveCountMax=4', '-o', 'LogLevel=ERROR', '-p', String(h.port || 22)];
  if (h.identityFile) a.push('-i', h.identityFile.replace(/^~/, os.homedir()), '-o', 'IdentitiesOnly=yes');
  if (h.auth === 'password') {
    a.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive');
    if (batch) a.push('-o', 'NumberOfPasswordPrompts=1');
  } else if (batch) {
    a.push('-o', 'BatchMode=yes');
  }
  return a;
}
function sshTarget(h) { return (h.user || 'root') + '@' + h.host; }

// Environment for a non-interactive ssh run; writes the password to a 0600 temp file
// consumed by the SSH_ASKPASS helper. Returns { env, cleanup }.
function sshJobEnv(h) {
  const env = Object.assign({}, process.env, { TERM: 'dumb' });
  let pwFile = null;
  if (h.auth === 'password' && h.password) {
    pwFile = path.join(SSH_HELPER_DIR, 'pw-' + crypto.randomBytes(8).toString('hex'));
    fs.writeFileSync(pwFile, h.password, { mode: 0o600 });
    Object.assign(env, { SSH_ASKPASS: SSH_ASKPASS_HELPER, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', RHC_SSH_PW_FILE: pwFile });
  }
  return { env, cleanup: () => { if (pwFile) try { fs.unlinkSync(pwFile); } catch (_) {} } };
}

// Run a remote command non-interactively; resolves { code, stdout, stderr }.
// `stdinData` (string/Buffer) or `stdinStream` (Readable) is fed to the remote command.
function sshRun(h, remoteCmd, { stdinData, stdinStream, timeoutMs = 60_000, onLine } = {}) {
  return new Promise((resolve) => {
    const { env, cleanup } = sshJobEnv(h);
    const args = sshBaseArgs(h, true).concat([sshTarget(h), remoteCmd]);
    const child = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false, lineBuf = { out: '', err: '' };
    const emit = (which, chunk) => {
      if (!onLine) return;
      lineBuf[which] += chunk;
      let i;
      while ((i = lineBuf[which].indexOf('\n')) >= 0) { onLine(lineBuf[which].slice(0, i).replace(/\r$/, ''), which); lineBuf[which] = lineBuf[which].slice(i + 1); }
    };
    const timer = setTimeout(() => { if (!done) { err += '\n[timeout after ' + Math.round(timeoutMs / 1000) + 's]'; child.kill('SIGKILL'); } }, timeoutMs);
    child.stdout.on('data', (d) => { const s = d.toString(); if (out.length < 2e6) out += s; emit('out', s); });
    child.stderr.on('data', (d) => { const s = d.toString(); if (err.length < 2e5) err += s; emit('err', s); });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      done = true; clearTimeout(timer); cleanup();
      if (onLine) { if (lineBuf.out) onLine(lineBuf.out, 'out'); if (lineBuf.err) onLine(lineBuf.err, 'err'); }
      resolve({ code, stdout: out, stderr: err });
    });
    if (stdinStream) stdinStream.pipe(child.stdin);
    else { if (stdinData != null) child.stdin.write(stdinData); child.stdin.end(); }
  });
}

async function sshTestHost(h) {
  const t0 = Date.now();
  const r = await sshRun(h, 'echo RHC_OK; uname -n; id -un; command -v node >/dev/null 2>&1 && node -v || echo "node: none"; command -v pm2 >/dev/null 2>&1 && echo "pm2 $(pm2 -v 2>/dev/null | tail -1)" || echo "pm2: none"; test -d /opt/rhc-srv-mon && echo "rhc-srv-mon: installed" || echo "rhc-srv-mon: not installed"', { timeoutMs: 30_000 });
  const ok = r.code === 0 && /RHC_OK/.test(r.stdout);
  return { ok, ms: Date.now() - t0, output: (r.stdout.replace(/RHC_OK\n?/, '') + (r.stderr ? '\n' + r.stderr : '')).trim() };
}

/* ---- minimal WebSocket (RFC 6455) ---- */
function wsHandshake(req, socket, protocol) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return false;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  // echo a requested subprotocol (noVNC asks for "binary" on older builds)
  const want = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const proto = protocol && want.includes(protocol) ? protocol : null;
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n'
    + (proto ? 'Sec-WebSocket-Protocol: ' + proto + '\r\n' : '') + '\r\n');
  return true;
}
function wsFrame(data, opcode) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = buf.length; let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([hdr, buf]);
}
function wsSendText(socket, s) { if (!socket.destroyed) socket.write(wsFrame(Buffer.from(String(s), 'utf8'), 1)); }
function wsSendBinary(socket, b) { if (!socket.destroyed) socket.write(wsFrame(b, 2)); }
function wsClose(socket, code, reason) {
  try {
    if (!socket.destroyed) {
      const p = Buffer.alloc(2 + Buffer.byteLength(reason || '')); p.writeUInt16BE(code || 1000, 0); if (reason) p.write(reason, 2);
      socket.write(wsFrame(p, 8));
    }
  } catch (_) {}
  setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 300);
}
// Attach a frame parser: onMessage(opcode, payloadBuffer), onClose().
function wsAttach(socket, head, onMessage, onClose, opts) {
  const textHeartbeat = !(opts && opts.textHeartbeat === false);
  let buf = Buffer.alloc(0), frag = [], fragOp = 0, closed = false, clientClosed = false, lastSeen = Date.now();
  // Keepalive: Cloudflare (and some proxies) drop a WebSocket with no traffic for ~100 s, which
  // the browser sees as close code 1006 on an idle terminal. Browsers auto-reply to pings with pongs;
  // the text heartbeat lets the page notice a silently dead transport (it answers with {"t":"hb"}).
  // If nothing at all arrives from the browser for WS_IDLE_DEAD_MS the transport is treated as lost.
  const finish = () => { if (!closed) { closed = true; clearInterval(pinger); onClose(clientClosed); } };
  const pinger = setInterval(() => {
    if (closed || socket.destroyed) return clearInterval(pinger);
    if (Date.now() - lastSeen > WS_IDLE_DEAD_MS) { try { socket.destroy(); } catch (_) {} return finish(); }
    socket.write(wsFrame(Buffer.alloc(0), 9));
    if (textHeartbeat) socket.write(wsFrame('{"t":"hb"}', 1));   // a raw byte stream (VNC) must not see text frames
  }, WS_PING_MS);
  socket.on('data', (chunk) => {
    if (closed) return;
    lastSeen = Date.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (buf.length > WS_MAX_BUFFER) { wsClose(socket, 1009, 'too big'); return finish(); }
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked && buf.length < off + 4) return;
      const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) { clientClosed = true; wsClose(socket, 1000); return finish(); }
      if (op === 9) { if (!socket.destroyed) socket.write(wsFrame(payload, 10)); continue; }
      if (op === 10) continue;
      if (op === 0) { frag.push(payload); if (fin) { const m = Buffer.concat(frag); frag = []; onMessage(fragOp, m); } continue; }
      if (!fin) { fragOp = op; frag = [payload]; continue; }
      onMessage(op, payload);
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  socket.on('end', finish);
  if (head && head.length) socket.unshift(head);
}

/* ---- interactive terminal session over WebSocket ---- */
// A session = one detached pty daemon (python3 + ssh, see SSH_PTY_HELPER_SRC) reached over a unix
// socket in .sessions/. The WebSocket is only the browser transport. Sessions live until closed from
// the UI (tab ×) or DELETE /api/ssh/sessions/:id — a refresh, a closed browser, a Cloudflare cut, a
// laptop sleep AND a restart of this manager only detach them: at startup the manager re-adopts every
// daemon listed in .sessions/*.json, and the page re-attaches with ?attach=<id> (history replayed).
const SSH_SESS_DIR = path.join(APP_ROOT, '.sessions');
function sshFrame(t, payload) { const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)); const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sshHelperConnect(sockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const c = net.connect(sockPath);
      c.once('connect', () => { c.removeAllListeners('error'); resolve(c); });
      c.once('error', () => { c.destroy(); if (Date.now() - t0 > (timeoutMs || 4000)) reject(new Error('pty daemon did not come up')); else setTimeout(tryOnce, 60); });
    };
    tryOnce();
  });
}
// Build the in-memory session object around a daemon (new or re-adopted) and register it.
function sshMakeSession(meta, host) {
  const sess = { id: meta.id, hostId: meta.hostId || null, host, label: meta.label, target: meta.target, startedAt: meta.startedAt, pid: meta.pid || null, sshPid: meta.sshPid || null,
    sockPath: path.join(SSH_SESS_DIR, meta.id + '.sock'), metaPath: path.join(SSH_SESS_DIR, meta.id + '.json'),
    conn: null, socket: null, ended: false, closeRequested: false, hist: [], histBytes: 0, detachedAt: null, attaches: 0 };
  sess.out = (d) => {
    sess.hist.push(d); sess.histBytes += d.length;
    while (sess.histBytes > SSH_SCROLLBACK_BYTES && sess.hist.length > 1) { const x = sess.hist.shift(); sess.histBytes -= x.length; }
    if (sess.socket && !sess.socket.destroyed) wsSendBinary(sess.socket, d);
  };
  sess.write = (d) => { if (sess.conn && !sess.conn.destroyed) sess.conn.write(sshFrame(0, d)); };
  sess.control = (o) => { if (sess.conn && !sess.conn.destroyed) sess.conn.write(sshFrame(2, JSON.stringify(o))); };
  sess.hangup = () => {
    sess.closeRequested = true; sess.control({ close: 1 });
    setTimeout(() => { if (!sess.ended) { try { if (sess.sshPid) process.kill(sess.sshPid, 'SIGKILL'); } catch (_) {} try { if (sess.pid) process.kill(sess.pid, 'SIGKILL'); } catch (_) {} sess.end(137, 'killed'); } }, 6000);
  };
  sess.end = (code, error) => {
    if (sess.ended) return; sess.ended = true;
    sshSessions.delete(sess.id);
    if (sess.socket) { try { wsSendText(sess.socket, JSON.stringify({ t: 'exit', code, error: error || null })); } catch (_) {} wsClose(sess.socket, 1000, 'session ended'); }
    try { if (sess.conn) sess.conn.destroy(); } catch (_) {}
    for (const f of [sess.sockPath, sess.metaPath]) { try { fs.unlinkSync(f); } catch (_) {} }
    console.log(`ssh session ${sess.id} (${sess.target}) ended, code ${code}${error ? ' (' + error + ')' : ''}`);
  };
  sshSessions.set(sess.id, sess);
  return sess;
}
// Attach the manager side to the daemon's unix socket and parse its frames.
function sshBindHelper(sess, conn) {
  sess.conn = conn; let buf = Buffer.alloc(0);
  conn.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 5) break;
      const t = buf[0], n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      const payload = Buffer.from(buf.subarray(5, 5 + n)); buf = buf.subarray(5 + n);
      if (t === 4) { sess.hist = payload.length ? [payload] : []; sess.histBytes = payload.length; sess.ready = true; }
      else if (t === 1) sess.out(payload);
      else if (t === 3) { let code = 0; try { code = JSON.parse(payload.toString()).code; } catch (_) {} sess.end(code); }
    }
  });
  conn.on('error', () => {});
  conn.on('close', () => {
    if (sess.conn !== conn || sess.ended) return;
    sess.conn = null;
    // daemon connection dropped without an exit frame: reconnect if it is still alive, else end
    if (sess.pid && pidAlive(sess.pid) && fs.existsSync(sess.sockPath)) {
      sshHelperConnect(sess.sockPath, 3000).then((c) => sshBindHelper(sess, c)).catch(() => sess.end(255, 'pty daemon unreachable'));
    } else sess.end(255, 'pty daemon gone');
  });
}
// Re-adopt daemons left running by a previous instance of this manager.
function sshAdoptDaemons() {
  let files = [];
  try { fs.mkdirSync(SSH_SESS_DIR, { recursive: true, mode: 0o700 }); files = fs.readdirSync(SSH_SESS_DIR).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  for (const f of files) {
    const metaPath = path.join(SSH_SESS_DIR, f);
    let meta = null; try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
    const sock = meta && meta.id ? path.join(SSH_SESS_DIR, meta.id + '.sock') : null;
    const cleanup = () => { for (const x of [metaPath, sock]) { try { if (x) fs.unlinkSync(x); } catch (_) {} } };
    if (!meta || !meta.id || !meta.pid || !pidAlive(meta.pid) || !fs.existsSync(sock)) { cleanup(); continue; }
    sshHelperConnect(sock, 1500).then((conn) => {
      const live = meta.hostId ? sshFindHost(meta.hostId) : null;
      const sess = sshMakeSession(meta, live || meta.host || null);
      sshBindHelper(sess, conn);
      console.log(`ssh session ${sess.id} (${sess.target}) re-adopted after manager restart (daemon pid ${meta.pid})`);
    }).catch(() => cleanup());
  }
}
function sshOpenTerminal(req, socket, head, query) {
  const cols = Math.max(20, Math.min(500, parseInt(query.get('cols')) || 120));
  const rows = Math.max(5, Math.min(200, parseInt(query.get('rows')) || 32));
  if (query.get('attach')) {
    const sess = sshSessions.get(String(query.get('attach')));
    if (!sess || sess.ended) { socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\nsession gone\n'); return socket.destroy(); }
    if (!wsHandshake(req, socket)) return;
    socket.setNoDelay(true);
    if (sess.socket && !sess.socket.destroyed) { const old = sess.socket; sess.socket = null; try { wsSendText(old, JSON.stringify({ t: 'superseded' })); } catch (_) {} wsClose(old, 1000, 'superseded'); }
    console.log(`ssh session ${sess.id} (${sess.target}) re-attached from ${clientIp(req)}`);
    sshAttachSocket(sess, socket, head, true, cols, rows);
    return;
  }
  let h = null;
  if (query.get('id')) {
    h = sshFindHost(query.get('id'));
    if (!h) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nunknown host\n'); return socket.destroy(); }
  } else {
    try { h = sshSanitizeHost({ host: query.get('host'), user: query.get('user') || 'root', port: query.get('port') || 22, auth: 'key' }); }
    catch (e) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n' + e.message + '\n'); return socket.destroy(); }
  }
  if (!wsHandshake(req, socket)) return;
  socket.setNoDelay(true);
  const id = crypto.randomBytes(6).toString('hex');
  const root = !!(h.becomeRoot && h.user !== 'root');
  const meta = { id, hostId: h.id || null, label: h.name || sshTarget(h), target: sshTarget(h) + (root ? ' (root)' : ''), startedAt: new Date().toISOString(), cols, rows,
    host: h.id ? null : Object.assign(sshPublicHost(h), { hasPassword: undefined }) };
  try { fs.mkdirSync(SSH_SESS_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(SSH_SESS_DIR, id + '.json'), JSON.stringify(meta), { mode: 0o600 }); } catch (e) { wsSendText(socket, JSON.stringify({ t: 'exit', code: 127, error: e.message })); return wsClose(socket, 1011, 'session dir'); }
  const env = Object.assign({}, process.env, { TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8', RHC_PTY_COLS: String(cols), RHC_PTY_ROWS: String(rows) });
  if (h.auth === 'password' && h.password) env.RHC_SSH_PASSWORD = h.password;
  // becomeRoot: `sudo -i` as the remote command (ssh -tt keeps the tty); a sudo password prompt is
  // answered by the daemon with the stored ssh password (same "assword:" match, 2 tries max).
  const args = [SSH_PTY_HELPER, path.join(SSH_SESS_DIR, id + '.sock'), 'ssh', '-tt'].concat(sshBaseArgs(h, false), [sshTarget(h)], root ? ['sudo', '-i'] : []);
  try { const launcher = spawn('python3', args, { env, stdio: 'ignore', detached: true }); launcher.on('error', () => {}); launcher.unref(); }
  catch (e) { wsSendText(socket, JSON.stringify({ t: 'exit', code: 127, error: e.message })); return wsClose(socket, 1011, 'spawn failed'); }
  sshHelperConnect(path.join(SSH_SESS_DIR, id + '.sock'), 5000).then((conn) => {
    try { Object.assign(meta, JSON.parse(fs.readFileSync(path.join(SSH_SESS_DIR, id + '.json'), 'utf8'))); } catch (_) {}
    const sess = sshMakeSession(meta, h);
    sshBindHelper(sess, conn);
    console.log(`ssh session ${id} -> ${sess.target} opened from ${clientIp(req)} (daemon pid ${meta.pid || '?'})`);
    if (socket.destroyed) { sess.detachedAt = Date.now(); return; }
    sshAttachSocket(sess, socket, head, false, cols, rows);
  }).catch((e) => {
    for (const f of [id + '.json', id + '.sock']) { try { fs.unlinkSync(path.join(SSH_SESS_DIR, f)); } catch (_) {} }
    wsSendText(socket, JSON.stringify({ t: 'exit', code: 127, error: 'could not start the terminal: ' + e.message }));
    wsClose(socket, 1011, 'daemon failed');
  });
}
// Bind a (new) WebSocket to a session: greet, replay history, wire keystrokes/resizes/close.
function sshAttachSocket(sess, socket, head, reattach, cols, rows) {
  sess.socket = socket; sess.attaches++;
  sess.detachedAt = null;
  wsSendText(socket, JSON.stringify({ t: 'hello', id: sess.id, target: sess.target, reattach: !!reattach }));
  if (reattach) {
    if (cols && rows) sess.control({ resize: [cols, rows] });
    if (sess.histBytes) wsSendBinary(socket, Buffer.concat(sess.hist));
    wsSendText(socket, JSON.stringify({ t: 'replayed', bytes: sess.histBytes }));
  }
  wsAttach(socket, head, (op, payload) => {
    if (op === 2) return sess.write(payload);
    if (op === 1) {
      const s = payload.toString('utf8');
      if (s[0] === '{') {
        try {
          const m = JSON.parse(s);
          if (m.t === 'resize') sess.control({ resize: [Math.max(20, Math.min(500, +m.cols || 80)), Math.max(5, Math.min(200, +m.rows || 24))] });
          else if (m.t === 'input' && typeof m.data === 'string') sess.write(m.data);
          else if (m.t === 'close') { console.log(`ssh session ${sess.id} closed from the UI -> hangup`); sess.hangup(); }
          // m.t === 'hb' -> heartbeat reply, nothing to do
        } catch (_) {}
      } else sess.write(s);
    }
  }, (clientClosed) => {
    if (sess.socket !== socket) return;      // superseded by a newer attach
    sess.socket = null;
    if (sess.ended || sess.closeRequested) return;
    sess.detachedAt = Date.now();
    console.log(`ssh session ${sess.id} (${sess.target}) detached (${clientClosed ? 'browser closed' : 'transport lost'}), kept until closed from the UI`);
  });
}
function sshHangup(sess) { sess.hangup(); }
// POST /api/ssh/sessions/:id/upload?name=<file> (raw body) — drop/paste a file or image into a
// terminal: it is written to ~/rhc-uploads/ on the remote host over a second ssh connection (same
// key / stored password) and the path is returned so the page can type it into the terminal.
function sshUploadToSession(req, res, sess) {
  if (!sess.host) { authJson(res, 400, { error: 'host record no longer available for this session' }); return req.destroy(); }
  const q = new URL(req.url || '/', 'http://localhost').searchParams;
  const name = (String(q.get('name') || 'upload.bin').replace(/[\/\\\0]/g, '_').replace(/[^\w.\- ()\[\]@+,]/g, '_').replace(/^\.+/, '_').slice(0, 120)) || 'upload.bin';
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > SSH_UPLOAD_MAX) { authJson(res, 413, { error: 'file too large (max ' + Math.round(SSH_UPLOAD_MAX / 1048576) + ' MB)' }); return req.destroy(); }
  const tmp = path.join(os.tmpdir(), 'rhc-up-' + crypto.randomBytes(8).toString('hex'));
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  let got = 0, tooBig = false, failed = false;
  const fail = (code, msg) => { if (failed) return; failed = true; try { fs.unlinkSync(tmp); } catch (_) {} if (!res.headersSent) authJson(res, code, { error: msg }); };
  req.on('data', (c) => { got += c.length; if (got > SSH_UPLOAD_MAX && !tooBig) { tooBig = true; req.destroy(); } });
  req.on('error', () => fail(400, 'upload aborted'));
  req.on('aborted', () => fail(400, 'upload aborted'));
  out.on('error', (e) => fail(500, e.message));
  req.pipe(out);
  out.on('finish', async () => {
    if (tooBig) return fail(413, 'file too large (max ' + Math.round(SSH_UPLOAD_MAX / 1048576) + ' MB)');
    if (failed) return;
    const cmd = `d="$HOME/rhc-uploads"; umask 077; mkdir -p "$d" && f="$d/${name}"; if [ -e "$f" ]; then f="$d/$(date +%Y%m%d-%H%M%S)-${name}"; fi; cat > "$f" && printf 'RHC_UP_OK %s\\n' "$f"`;
    const r = await sshRun(sess.host, cmd, { stdinStream: fs.createReadStream(tmp), timeoutMs: 900_000 });
    try { fs.unlinkSync(tmp); } catch (_) {}
    const mm = r.stdout.match(/RHC_UP_OK (.+)/);
    if (r.code !== 0 || !mm) return fail(502, 'remote write failed: ' + (r.stderr.trim().split('\n').pop() || r.stdout.trim() || 'exit ' + r.code));
    console.log(`ssh session ${sess.id}: uploaded ${name} (${got} bytes) -> ${mm[1].trim()}`);
    authJson(res, 200, { ok: true, path: mm[1].trim(), bytes: got });
  });
}

/* ---- remote install of rhc-srv-mon ---- */
function sshSourceInfo() {
  let git = null;
  try { git = execFileSync('git', ['-C', APP_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch (_) {}
  return { host: os.hostname(), node: process.version, port: PORT, appDir: APP_ROOT, git };
}

// Build the settings bundle that mirrors *this* server's configuration but none
// of its host-specific data (project scans, logs, per-host DB/site selections).
function sshPushInstallLog(job) {
  const summary = { id: job.id, hostId: job.hostId, hostName: job.hostName, target: job.target, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, opts: job.opts, error: job.error || null, log: job.log.slice(-200) };
  const i = sshCache.installLog.findIndex((j) => j.id === job.id);
  if (i >= 0) sshCache.installLog[i] = summary; else sshCache.installLog.push(summary);
  sshCache.installLog = sshCache.installLog.slice(-SSH_INSTALL_LOG_MAX);
  saveSsh();
}

async function runVncInstall(job, h, secret) {
  const log = (line, kind) => {
    for (const l of String(line).split('\n')) {
      if (l === '' && kind !== 'hdr') continue;
      job.log.push({ t: new Date().toISOString(), k: kind || 'info', m: l.slice(0, 2000) });
      if (job.log.length > SSH_JOB_LOG_MAX) job.log.splice(0, job.log.length - SSH_JOB_LOG_MAX);
    }
  };
  const o = job.opts;
  let sudoTmp = null;
  try {
    log('Deploying a VNC server on ' + sshTarget(h) + ' — display :' + o.display + ' for ' + o.vncUser + ', ' + o.geometry + ', desktop ' + o.desktop, 'hdr');
    job.step = 'preflight';
    const pre = await sshRun(h, 'echo RHC_PRE; echo "UID=$(id -u)"; echo "USER=$(id -un)"; echo "HOST=$(uname -n)"; echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"; echo "SUDO=$(command -v sudo || true)"; echo "XVNC=$(command -v Xvnc || command -v Xtigervnc || true)"; echo "XFCE=$(command -v startxfce4 || true)"; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then sudo -n true >/dev/null 2>&1 && echo SUDO_OK=yes || echo SUDO_OK=no; fi', { timeoutMs: 45_000 });
    if (pre.code !== 0 || !/RHC_PRE/.test(pre.stdout)) throw new Error('SSH connection failed: ' + (pre.stderr.trim() || ('exit ' + pre.code)));
    const kv = {}; for (const l of pre.stdout.split('\n')) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) kv[m[1]] = m[2]; }
    log('Target ' + (kv.HOST || '?') + ' · ' + (kv.OS || 'unknown OS') + ' · user ' + (kv.USER || '?'));
    log('Found: Xvnc ' + (kv.XVNC || 'none') + ' · xfce ' + (kv.XFCE ? 'yes' : 'no'));
    let sudo = '';
    if (kv.UID !== '0') {
      if (kv.SUDO && kv.SUDO_OK === 'yes') { sudo = 'sudo -n '; log('Not root: using passwordless sudo'); }
      else if (kv.SUDO && secret && secret.sudoPassword) {
        const setup = await sshRun(h, 'umask 077; d=$(mktemp -d "${TMPDIR:-/tmp}/.rhc-sudo.XXXXXX") && IFS= read -r pw && printf "%s\n" "$pw" > "$d/pw" && printf "#!/bin/sh\ncat %s/pw\n" "$d" > "$d/ask" && chmod 700 "$d/ask" && SUDO_ASKPASS="$d/ask" sudo -A -k true 2>/dev/null && echo "RHC_SUDO_OK $d" || { rm -rf "$d"; echo RHC_SUDO_BAD; }', { stdinData: secret.sudoPassword + '\n', timeoutMs: 45_000 });
        const sm = setup.stdout.match(/RHC_SUDO_OK (\S+)/);
        if (!sm) throw new Error('sudo rejected the password for ' + (kv.USER || 'the remote user'));
        sudoTmp = sm[1]; sudo = 'SUDO_ASKPASS=' + JSON.stringify(sudoTmp + '/ask') + ' sudo -A ';
        log('Not root, no passwordless sudo: using the sudo password from the dialog');
      } else throw new Error('Remote user is not root and has no passwordless sudo. Connect as root, enter the sudo password, or configure NOPASSWD sudo.');
    }
    job.step = 'install'; log('Running the installer (package install can take a few minutes)…');
    const envs = ['DISPLAY_NUM=' + o.display, 'VNC_USER=' + JSON.stringify(o.vncUser), 'GEOMETRY=' + JSON.stringify(o.geometry),
                  'DESKTOP=' + JSON.stringify(o.desktop), 'PASSWD_B64=' + JSON.stringify(secret.passwdB64)].join(' ');
    const r = await sshRun(h, sudo + 'env ' + envs + ' sh -s', { stdinData: vncDeployScript(), timeoutMs: 45 * 60_000, onLine: (l, which) => log(l, which === 'err' ? 'err' : 'remote') });
    const m = /RHC_VNC_OK (\d+) (\S+)/.exec(r.stdout);
    if (r.code !== 0 || !m) throw new Error('the remote installer exited with code ' + r.code + ({ 2: ' (package install)', 3: ' (user)', 4: ' (password file)', 5: ' (service start)', 6: ' (nothing listening)' }[r.code] || ''));
    job.result = { port: Number(m[1]), unit: m[2], display: o.display, user: o.vncUser };
    job.status = 'ok';
    log('✅ VNC server ready on 127.0.0.1:' + job.result.port + ' (' + job.result.unit + ')', 'hdr');
    log('It listens on loopback only — reach it through this host\'s SSH connection.');
  } catch (e) {
    job.status = 'failed'; job.error = e.message; log('❌ ' + e.message, 'err');
  } finally {
    job.finishedAt = new Date().toISOString(); job.step = null;
    if (sudoTmp) { try { await sshRun(h, 'rm -rf ' + JSON.stringify(sudoTmp), { timeoutMs: 20_000 }); } catch (_) {} }
    sshPushInstallLog(job);
  }
}

// opts: { display, vncUser, geometry, desktop, password, sudoPassword, createHost }
function sshStartVncInstall(hostId, optsIn) {
  const h = sshFindHost(hostId);
  if (!h) throw Object.assign(new Error('Unknown host'), { status: 404 });
  if ([...sshInstallJobs.values()].some((j) => j.status === 'running' && j.hostId === hostId)) throw Object.assign(new Error('A deployment is already running for this host'), { status: 409 });
  const o = optsIn || {};
  const display = Math.max(1, Math.min(99, parseInt(o.display) || 1));
  const password = typeof o.password === 'string' && o.password ? o.password.slice(0, 8) : crypto.randomBytes(6).toString('base64url').slice(0, 8);
  const opts = {
    display, vncUser: /^[a-z_][a-z0-9_-]{0,31}$/.test(String(o.vncUser || '')) ? String(o.vncUser) : (h.user || 'root'),
    geometry: /^\d{3,5}x\d{3,5}$/.test(String(o.geometry || '')) ? String(o.geometry) : '1280x800',
    desktop: ['xfce', 'none'].includes(o.desktop) ? o.desktop : 'xfce',
    createHost: o.createHost !== false,
  };
  const job = { id: crypto.randomBytes(6).toString('hex'), kind: 'vnc', hostId, hostName: h.name, target: sshTarget(h), status: 'running',
    step: 'queued', startedAt: new Date().toISOString(), finishedAt: null, opts, log: [], error: null, result: null };
  sshInstallJobs.set(job.id, job);
  const finished = [...sshInstallJobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  while (finished.length > 10) sshInstallJobs.delete(finished.shift().id);
  const passwdB64 = require('./vnc-passwd').encodePasswd(password).toString('base64');
  runVncInstall(job, Object.assign({}, h), { sudoPassword: typeof o.sudoPassword === 'string' ? o.sudoPassword.slice(0, 256) : '', passwdB64 })
    .then(() => {
      // wire it up so the host can be opened straight away
      if (job.status === 'ok' && opts.createHost) {
        const live = sshFindHost(hostId);
        if (live) {
          Object.assign(live, { protocol: 'vnc', vncHost: '127.0.0.1', vncPort: job.result.port, vncTunnel: true, vncPassword: password, vncViewOnly: false });
          live.vnc = { deployedAt: new Date().toISOString(), display: opts.display, unit: job.result.unit, user: opts.vncUser };
          saveSsh();
          job.log.push({ t: new Date().toISOString(), k: 'hdr', m: 'Host "' + live.name + '" now opens as a VNC viewer (click it in the list).' });
          sshPushInstallLog(job);
        }
      }
    })
    .catch((e) => { job.status = 'failed'; job.error = e.message; job.finishedAt = new Date().toISOString(); sshPushInstallLog(job); });
  return Object.assign({}, job, { password });
}


function sshApiState() {
  const jobs = [...sshInstallJobs.values()].map((j) => Object.assign({}, j, { log: undefined, logLines: j.log.length }));
  const seen = new Set(jobs.map((j) => j.id));
  const hist = sshCache.installLog.filter((j) => !seen.has(j.id)).map((j) => Object.assign({}, j, { log: undefined, logLines: (j.log || []).length }));
  return {
    hosts: sshCache.hosts.map(sshPublicHost),
    sessions: [...sshSessions.values()].map((s) => ({ id: s.id, hostId: s.hostId, label: s.label, target: s.target, startedAt: s.startedAt, attached: !!s.socket, detachedAt: s.detachedAt })),
    installs: jobs.concat(hist).sort((a, b) => a.startedAt < b.startedAt ? 1 : -1).slice(0, SSH_INSTALL_LOG_MAX),
    source: sshSourceInfo(),
    helperOk: fs.existsSync(SSH_PTY_HELPER),
  };
}
// Who is logged in on the remote host right now. logind is asked first (KEY=VALUE output, no column
// guessing); `who -u` is the fallback for hosts without systemd. `ss` adds the connections that have
// no login attached (sftp, scp, port forwards). Everything is parsed here, not in shell.
const REMOTE_SESSIONS_CMD = [
  'if command -v loginctl >/dev/null 2>&1; then',
  '  for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk \'{print $1}\'); do',
  '    loginctl show-session "$sid" -p Id -p Name -p Service -p Leader -p Remote -p RemoteHost -p TTY -p Timestamp -p IdleHint -p Type 2>/dev/null | sed "s/^/S:/";',
  '    echo "S:--";',
  '  done;',
  'fi',
  'echo RHC_SEP',
  'LC_ALL=C who -u 2>/dev/null | sed "s/^/W:/"',
  'echo RHC_SEP',
  'LC_ALL=C ss -tnpH state established "( sport = :22 )" 2>/dev/null | sed "s/^/C:/"',
  'echo RHC_SEP',
  // what each session scope still holds — a login whose scope runs pm2/node is somebody's service
  'LC_ALL=C ps -eo pid=,user=,comm=,cgroup= 2>/dev/null | grep -F ".scope" | sed "s/^/P:/"',
].join('\n');

function parseRemoteSessions(stdout) {
  const [sPart = '', wPart = '', cPart = '', pPart = ''] = stdout.split('RHC_SEP');
  // pid/user/comm per logind session scope
  const scope = new Map();   // session id -> [{ pid, user, comm }]
  for (const raw of pPart.split('\n')) {
    if (!raw.startsWith('P:')) continue;
    const m = /^P:\s*(\d+)\s+(\S+)\s+(\S+)\s+.*?session-(\d+)\.scope/.exec(raw);
    if (!m) continue;
    if (!scope.has(m[4])) scope.set(m[4], []);
    const list = scope.get(m[4]);
    if (list.length < 50) list.push({ pid: Number(m[1]), user: m[2], comm: m[3] });
  }
  const sessions = [];
  // logind: one KEY=VALUE block per session, terminated by "--"
  let cur = {};
  for (const raw of sPart.split('\n')) {
    const line = raw.startsWith('S:') ? raw.slice(2) : null;
    if (line === null) continue;
    if (line.trim() === '--') {
      if (cur.Leader && (cur.Service === 'sshd' || cur.Remote === 'yes')) {
        const procs = scope.get(String(cur.Id)) || [];
        const leaderAlive = procs.some((x) => x.pid === Number(cur.Leader));
        // what would die with the scope, ignoring the login shell itself
        const services = procs.filter((x) => !/^(sshd|sshd-session|bash|sh|zsh|fish|login|systemd|\(sd-pam\)|ps|grep|sed|awk)$/.test(x.comm));
        sessions.push({ user: cur.Name || '?', tty: cur.TTY || '', type: cur.Type || '', from: cur.RemoteHost || '', pid: Number(cur.Leader) || 0,
          since: (cur.Timestamp || '').replace(/^\w{3} /, '').slice(0, 16), idle: cur.IdleHint === 'yes' ? 'idle' : '', source: 'logind', id: cur.Id || '',
          state: cur.State || '', leaderAlive, procCount: procs.length,
          services: [...new Set(services.map((x) => x.comm))].slice(0, 8),
          hasServices: services.length > 0 });
      }
      cur = {}; continue;
    }
    const i = line.indexOf('=');
    if (i > 0) cur[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  // who -u fallback: the last column is "(host)", the one before it the PID, then the idle column
  if (!sessions.length) {
    for (const raw of wPart.split('\n')) {
      if (!raw.startsWith('W:')) continue;
      const f = raw.slice(2).trim().split(/\s+/);
      if (f.length < 5) continue;
      const from = /^\(.*\)$/.test(f[f.length - 1]) ? f[f.length - 1].slice(1, -1) : '';
      const rest = from ? f.slice(0, -1) : f;
      const pid = Number(rest[rest.length - 1]) || 0;
      if (!pid) continue;
      sessions.push({ user: f[0], tty: f[1] === 'sshd' && f[2] && /^(pts|tty)/.test(f[2]) ? f[2] : f[1], from,
        since: rest.slice(2, rest.length - 2).join(' '), idle: rest[rest.length - 2] || '', pid, source: 'who' });
    }
  }
  const connections = [];
  for (const raw of cPart.split('\n')) {
    if (!raw.startsWith('C:')) continue;
    const m = /(\S+):(\d+)\s+(\S+):(\d+)/.exec(raw.slice(2).trim());
    const pids = [...raw.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
    if (m) connections.push({ local: m[1] + ':' + m[2], peer: m[3] + ':' + m[4], pid: pids.length ? Math.min(...pids) : 0, pids });
  }
  return { sessions, connections };
}

async function sshRemoteSessions(h) {
  const r = await sshRun(h, REMOTE_SESSIONS_CMD, { timeoutMs: 30_000 });
  if (r.code !== 0 && !/RHC_SEP/.test(r.stdout)) throw Object.assign(new Error('ssh failed: ' + (r.stderr || 'exit ' + r.code).trim().split('\n').pop()), { status: 502 });
  const parsed = parseRemoteSessions(r.stdout);
  // sessions coming from this server are most likely the panel's own (this probe, or an open terminal)
  const mine = new Set(Object.values(os.networkInterfaces()).flat().filter((i) => !i.internal).map((i) => i.address));
  for (const x of parsed.sessions) x.fromPanel = mine.has(x.from);
  // a connection whose pid (or its peer sshd pid) already has a login is not listed twice
  const known = new Set(parsed.sessions.map((s) => s.pid));
  parsed.connections = parsed.connections.filter((c) => !c.pids.some((p) => known.has(p)));
  return Object.assign(parsed, { checkedAt: new Date().toISOString() });
}
// Disconnect remote logins: hang up their sshd processes. Every pid is verified against the live
// list first, so these endpoints can never be used to signal an arbitrary process.
// mode 'hangup'  — end the login only (signal its sshd process). Anything it left running keeps
//                   running, which is what people expect from "disconnect".
// mode 'kill'     — terminate the whole logind session scope. This also stops services the login
//                   started (pm2 daemons and their apps live here on a box where nobody enabled
//                   lingering), so it is never the default.
async function sshKillRemoteSessions(h, pids, known, mode) {
  mode = mode === 'kill' ? 'kill' : 'hangup';
  const wanted = [...new Set(pids.map(Number).filter((p) => Number.isInteger(p) && p > 1))];
  if (!wanted.length) throw Object.assign(new Error('no session to disconnect'), { status: 400 });
  const cur = known || await sshRemoteSessions(h);
  const byPid = new Map();
  for (const x of cur.sessions) byPid.set(x.pid, x);
  for (const c of cur.connections) for (const p of [c.pid].concat(c.pids || [])) if (p && !byPid.has(p)) byPid.set(p, { pid: p });
  const signal = wanted.filter((p) => byPid.has(p));
  const stale = wanted.filter((p) => !byPid.has(p));
  if (!signal.length) throw Object.assign(new Error('pid ' + wanted.join(', ') + (wanted.length === 1 ? ' is not a current ssh session on this host' : ' are no longer current ssh sessions on this host')), { status: 409 });
  const specs = signal.map((p) => (byPid.get(p).id ? byPid.get(p).id : '-') + ':' + p).join(' ');
  const script = fs.readFileSync(path.join(APP_ROOT, 'resources', 'disconnect-sessions.sh'), 'utf8');
  const r = await sshRun(h, 'MODE=' + mode + ' sh -s ' + specs, { stdinData: script, timeoutMs: 120_000 });
  const results = signal.map((pid) => {
    const sess = byPid.get(pid);
    return { pid, ok: new RegExp('GONE ' + pid + '\\b').test(r.stdout), user: sess.user, kept: mode === 'hangup' && sess.hasServices ? sess.services : undefined };
  }).concat(stale.map((pid) => ({ pid, ok: true, note: 'already gone' })));
  return { mode, results, ok: results.every((x) => x.ok), output: (r.stderr || '').trim().slice(0, 500) };
}
async function sshKillRemoteSession(h, pid, mode) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw Object.assign(new Error('invalid pid'), { status: 400 });
  const cur = await sshRemoteSessions(h);
  const sess = cur.sessions.find((x) => x.pid === pid);
  // nothing to hang up: the login is already over and only leftovers remain
  if (sess && mode !== 'kill' && sess.leaderAlive === false) {
    throw Object.assign(new Error('that login has already ended — its sshd process is gone' + (sess.hasServices ? ', but ' + sess.procCount + ' process(es) it started are still running (' + sess.services.join(', ') + '). Use "kill session" to stop those too.' : ', and nothing it started is left running.')), { status: 409, code: 'ALREADY_ENDED' });
  }
  const r = await sshKillRemoteSessions(h, [pid], cur, mode);
  return { ok: r.results[0].ok, pid, mode: r.mode, kept: r.results[0].kept, output: r.output };
}
// Every login except the ones coming from this panel (its own probe and open terminals).
async function sshDisconnectOthers(h, opts) {
  opts = opts || {};
  const mode = opts.mode === 'kill' ? 'kill' : 'hangup';
  const cur = await sshRemoteSessions(h);
  const panel = cur.sessions.filter((x) => x.fromPanel);
  let targets = cur.sessions.filter((x) => !x.fromPanel && x.pid > 1);
  // in the safe mode a login that has already ended has nothing to hang up — skip it instead of
  // reaching into its scope, and say so
  const ended = mode === 'hangup' ? targets.filter((x) => x.leaderAlive === false) : [];
  if (mode === 'hangup') targets = targets.filter((x) => x.leaderAlive !== false);
  const withServices = targets.filter((x) => x.hasServices);
  const view = (t) => ({ pid: t.pid, user: t.user, from: t.from, services: t.services, procCount: t.procCount, leaderAlive: t.leaderAlive });
  if (opts.dryRun) return { dryRun: true, mode, targets: targets.map(view), skippedEnded: ended.map(view), withServices: withServices.map(view), kept: panel.length };
  if (!targets.length) return { ok: true, mode, results: [], kept: panel.length, skippedEnded: ended.map(view), none: true };
  const r = await sshKillRemoteSessions(h, targets.map((t) => t.pid), cur, mode);
  return Object.assign(r, { kept: panel.length, skippedEnded: ended.map(view), targets: targets.map(view) });
}

// Install history housekeeping. Running jobs are never removed (their log is still being written).
// Forget every install except the ones genuinely running in THIS process. Whether an entry is live
// is decided by sshInstallJobs, never by a stored status field, and the count is of distinct ids —
// a finished job sits in both the job map and the log, and used to be counted twice.
function clearInstallLog() {
  const live = new Set([...sshInstallJobs.entries()].filter(([, j]) => j.status === 'running').map(([id]) => id));
  const ids = new Set([...sshCache.installLog.map((j) => j.id), ...sshInstallJobs.keys()].filter((id) => !live.has(id)));
  sshCache.installLog = sshCache.installLog.filter((j) => live.has(j.id));
  for (const id of sshInstallJobs.keys()) if (!live.has(id)) sshInstallJobs.delete(id);
  saveSsh();
  return { removed: ids.size, kept: live.size };
}
function removeInstallJob(id) {
  const j = sshFindJob(id);
  if (!j) return { removed: false };
  const live = sshInstallJobs.get(id);
  if (live && live.status === 'running') throw Object.assign(new Error('that install is still running'), { status: 409 });
  sshInstallJobs.delete(id);
  sshCache.installLog = sshCache.installLog.filter((x) => x.id !== id);
  saveSsh();
  return { removed: true };
}
function sshFindJob(id) {
  return sshInstallJobs.get(id) || sshCache.installLog.find((j) => j.id === id) || null;
}



// Accessors for the dispatcher.
function getHosts() { return sshCache.hosts; }
function addHost(h) { sshCache.hosts.push(h); saveSsh(); }
function removeHost(id) { sshCache.hosts = sshCache.hosts.filter((x) => x.id !== id); saveSsh(); }
function getSession(id) { return sshSessions.get(id); }
function sessionMetaExists(id) { return fs.existsSync(path.join(SSH_SESS_DIR, id + '.json')); }

module.exports = { sshStartVncInstall, wsClose, clientIpOf: clientIp, sshFindHost, wsHandshake, wsFrame, wsSendText, wsSendBinary, wsAttach, sshBaseArgs, sshTarget, sshJobEnv, ensureSshHelpers, loadSsh, saveSsh, sshAdoptDaemons, sshOpenTerminal, sshUploadToSession, sshApiState, clearInstallLog, removeInstallJob, sshRemoteSessions, sshKillRemoteSession, sshKillRemoteSessions, sshDisconnectOthers, parseRemoteSessions,
  sshSanitizeHost, sshPublicHost, sshFindHost, sshFindJob, sshTestHost, wsClose,
  getHosts, addHost, removeHost, getSession, sessionMetaExists };
