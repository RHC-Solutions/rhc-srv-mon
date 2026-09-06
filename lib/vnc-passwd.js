'use strict';
// VNC password helpers. VNC stores a password as the 8-byte password DES-encrypted with a fixed key,
// and authenticates by DES-encrypting the server's 16-byte challenge with the password as key. Both
// use DES with the bit order of every key byte reversed (the d3des quirk every VNC client inherits).
// Doing this here means deploying a server does not depend on which vncpasswd variant a distro ships.
// OpenSSL 3 moved DES to the legacy provider, so this goes through the openssl CLI.
const { execFileSync } = require('child_process');

const FIXED_KEY = Buffer.from([23, 82, 107, 6, 35, 78, 88, 7]);
const revByte = (b) => { let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i; return r; };
const vncKeyHex = (buf) => Buffer.from(Array.from(buf).map(revByte)).toString('hex');
function key8(password) {
  const b = Buffer.alloc(8);
  Buffer.from(String(password), 'latin1').copy(b, 0, 0, 8);
  return b;
}
function des(keyBuf, data, decrypt) {
  const args = ['enc', '-des-ecb', '-K', vncKeyHex(keyBuf), '-nopad', '-provider', 'legacy', '-provider', 'default'];
  if (decrypt) args.push('-d');
  try { return execFileSync('openssl', args, { input: Buffer.from(data), maxBuffer: 1 << 20, timeout: 10_000 }); }
  catch (e) { throw new Error('DES is unavailable (openssl legacy provider): ' + (e.stderr ? e.stderr.toString().trim().split('\n')[0] : e.message)); }
}
// Content of ~/.vnc/passwd for this password (8 bytes).
function encodePasswd(password) { return des(FIXED_KEY, key8(password)); }
// The password stored in such a file.
function decodePasswd(buf) { return des(FIXED_KEY, Buffer.from(buf).subarray(0, 8), true).toString('latin1').replace(/\0+$/, ''); }
// RFB VncAuth response to a 16-byte challenge.
function challengeResponse(password, challenge) { return des(key8(password), Buffer.from(challenge).subarray(0, 16)); }
function available() { try { des(FIXED_KEY, Buffer.alloc(8)); return true; } catch (_) { return false; } }

module.exports = { encodePasswd, decodePasswd, challengeResponse, available };
