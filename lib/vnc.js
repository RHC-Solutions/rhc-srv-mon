'use strict';
// VNC: a WebSocket ↔ TCP bridge so noVNC in the browser can talk RFB to a server that is normally
// bound to the target's loopback. Two ways to reach it:
//   tunnel (default) — `ssh -W <vncHost>:<vncPort> user@host`, i.e. the VNC port as seen from the
//                      target itself, using the host's existing SSH credentials. Nothing is exposed.
//   direct           — a plain TCP connection from this server to <vncHost>:<vncPort>.
// The stream is passed through untouched; noVNC does the RFB protocol and (with the stored password)
// the authentication.
const net = require('net');
const { spawn } = require('child_process');
const ssh = require('./ssh');

const IDLE_MS = 4 * 60 * 60_000;   // a viewer left open all day is fine; a forgotten one is not

function targetOf(h) {
  return { host: h.vncHost || '127.0.0.1', port: Number(h.vncPort) || 5901, tunnel: h.vncTunnel !== false };
}
// A duplex "stream" for the bridge: { write, end, onData, onClose, describe }.
function openTarget(h, onData, onClose) {
  const t = targetOf(h);
  if (t.tunnel) {
    const { env, cleanup } = ssh.sshJobEnv(h);
    const args = ssh.sshBaseArgs(h, true).concat(['-W', t.host + ':' + t.port, ssh.sshTarget(h)]);
    const child = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString().slice(0, 2000); });
    child.stdout.on('data', onData);
    child.on('close', (code) => { cleanup(); onClose(code === 0 ? null : (err.trim().split('\n').pop() || ('ssh exited ' + code))); });
    child.on('error', (e) => { cleanup(); onClose(e.message); });
    return { write: (b) => { try { child.stdin.write(b); } catch (_) {} }, end: () => { try { child.kill('SIGTERM'); } catch (_) {} },
      describe: 'ssh -W ' + t.host + ':' + t.port + ' ' + ssh.sshTarget(h) };
  }
  const sock = net.connect({ host: t.host, port: t.port });
  sock.on('data', onData);
  sock.on('error', (e) => onClose(e.message));
  sock.on('close', () => onClose(null));
  return { write: (b) => { try { sock.write(b); } catch (_) {} }, end: () => { try { sock.destroy(); } catch (_) {} },
    describe: 'tcp ' + t.host + ':' + t.port };
}

// GET /ws/vnc?id=<hostId> (upgraded). Everything the browser sends is RFB, and vice versa.
function openVncBridge(req, socket, head, query) {
  const fail = (code, msg) => { socket.write('HTTP/1.1 ' + code + ' ' + msg + '\r\nConnection: close\r\n\r\n'); socket.destroy(); };
  const id = String(query.get('id') || '');
  let h;
  if (id.startsWith('rdp:')) {                       // an RDP session's own X display on this server
    const sess = require('./rdp').get(id.slice(4));
    if (!sess) return fail(404, 'That RDP session is gone');
    h = require('./rdp').localHostFor(sess);
  } else {
    h = ssh.sshFindHost(id);
    if (!h) return fail(404, 'Unknown host');
    if ((h.protocol || 'ssh') !== 'vnc') return fail(400, 'Not a VNC host');
  }
  if (!ssh.wsHandshake(req, socket, 'binary')) return;

  let target = null, closed = false;
  const shut = (why) => {
    if (closed) return; closed = true;
    clearTimeout(idle);
    if (target) target.end();
    ssh.wsClose(socket, 1000, why || 'closed');
  };
  const idle = setTimeout(() => shut('idle'), IDLE_MS);
  try {
    target = openTarget(h,
      (chunk) => { if (!closed && !socket.destroyed) socket.write(ssh.wsFrame(chunk, 2)); },
      // never inject bytes into the RFB stream — the viewer would read them as protocol data
      (err) => shut(err || 'target closed'));
  } catch (e) { return fail(502, 'Cannot reach the VNC server'); }
  console.log('vnc bridge ' + h.name + ' -> ' + target.describe + ' from ' + ssh.clientIpOf(req));
  // binary frames are RFB bytes; text frames are ignored (nothing legitimate sends them here)
  ssh.wsAttach(socket, head, (op, payload) => { if (op === 2 && target) target.write(payload); }, () => shut('client closed'), { textHeartbeat: false });
}

// Try the target once and report what happened, so the viewer can show a real reason instead of a
// blank canvas. Resolves { ok, greeting } or { ok:false, error }.
function probe(h, timeoutMs) {
  return new Promise((resolve) => {
    let done = false, got = Buffer.alloc(0), target = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { if (target) target.end(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: 'timed out waiting for the VNC server' }), timeoutMs || 12_000);
    try {
      target = openTarget(h,
        (chunk) => {
          got = Buffer.concat([got, chunk]);
          if (got.length >= 12) {
            const greeting = got.subarray(0, 12).toString('latin1').trim();
            finish(/^RFB \d{3}\.\d{3}$/.test(greeting) ? { ok: true, greeting } : { ok: false, error: 'the port answered, but not with the VNC protocol' });
          }
        },
        (err) => finish({ ok: false, error: err || 'the connection closed before the VNC greeting' }));
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

module.exports = { openVncBridge, targetOf, probe };
