'use strict';
// Wasabi (S3-compatible) as the backup target, configured in Settings → Wasabi.
//
// Config lives in kv `wasabi` = { accessKey, secretKey (encrypted by secrets.js), region, bucket,
// prefix }. rclone gets the remote through RCLONE_CONFIG_WASABI_* environment variables, so the
// keys never land in a plaintext rclone.conf — only this panel's encrypted settings hold them.
//
// Hosts that predate this setting (web01) have a hand-written /root/.config/rclone/rclone.conf
// with remote "remote:" and bucket "rhcsolutions"; with no panel config that keeps working as is.
const fs = require('fs');
const os = require('os');
const { settings } = require('./db');
const secrets = require('./secrets');

const KEY = 'wasabi';
const LEGACY_CONF = '/root/.config/rclone/rclone.conf';
const LEGACY = { remote: 'remote:', bucket: 'rhcsolutions', endpoint: 's3.eu-central-1.wasabisys.com' };
// Wasabi's service regions (https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions)
const REGIONS = ['us-east-1', 'us-east-2', 'us-central-1', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-central-1', 'eu-central-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2'];
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9._-]{1,64}$/;
const hostPrefix = () => (String(os.hostname() || 'unknown').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'unknown') + '-backups';
const endpointOf = (region) => 's3.' + region + '.wasabisys.com';

function raw() { return settings.get(KEY, null); }
function get() {
  const r = raw();
  if (!r) return null;
  let secretKey = ''; try { secretKey = r.secretKey ? secrets.decrypt(r.secretKey) : ''; } catch (_) {}
  return { accessKey: r.accessKey || '', secretKey, region: r.region || 'eu-central-1', bucket: r.bucket || '', prefix: r.prefix || hostPrefix() };
}
function configured() { const c = get(); return !!(c && c.accessKey && c.secretKey && c.bucket); }

// Validates and stores. An empty secretKey keeps the stored one (the UI never gets it back).
function save(input) {
  const cur = get() || {};
  const next = {
    accessKey: String(input.accessKey != null ? input.accessKey : cur.accessKey || '').trim(),
    secretKey: input.secretKey ? String(input.secretKey).trim() : (cur.secretKey || ''),
    region: String(input.region || cur.region || 'eu-central-1').trim(),
    bucket: String(input.bucket != null ? input.bucket : cur.bucket || '').trim().toLowerCase(),
    prefix: String(input.prefix || cur.prefix || hostPrefix()).trim(),
  };
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!/^[A-Z0-9]{16,128}$/.test(next.accessKey)) throw bad('access key: letters A–Z and digits only, as Wasabi shows it');
  if (!next.secretKey || next.secretKey.length < 20 || /\s/.test(next.secretKey)) throw bad('secret key missing or malformed');
  if (!REGIONS.includes(next.region)) throw bad('unknown Wasabi region ' + next.region);
  if (!BUCKET_RE.test(next.bucket)) throw bad('bucket name: 3–63 lowercase letters, digits, dots and dashes');
  if (!PREFIX_RE.test(next.prefix)) throw bad('folder: letters, digits, dot, dash, underscore');
  settings.set(KEY, { accessKey: next.accessKey, secretKey: secrets.encrypt(next.secretKey), region: next.region, bucket: next.bucket, prefix: next.prefix });
  return view();
}
function clear() { settings.del(KEY); }

// What a backup run talks to: rclone remote, bucket, folder, env and a label for the UI/messages.
// null when nothing is configured at all (no panel config, no legacy rclone.conf).
// cfg: a site's own Wasabi settings (Overrides tab) instead of the shared ones.
function target(cfg) {
  const c = cfg ? Object.assign({ region: 'eu-central-1' }, cfg, { prefix: cfg.prefix || hostPrefix() }) : get();
  if (c && c.accessKey && c.secretKey && c.bucket) {
    return {
      kind: 'panel', remote: 'wasabi:', bucket: c.bucket, prefix: c.prefix, endpoint: endpointOf(c.region),
      args: ['--s3-no-check-bucket'],
      env: Object.assign({}, process.env, {
        HOME: '/root', RCLONE_CONFIG: '/dev/null',
        RCLONE_CONFIG_WASABI_TYPE: 's3', RCLONE_CONFIG_WASABI_PROVIDER: 'Wasabi',
        RCLONE_CONFIG_WASABI_ACCESS_KEY_ID: c.accessKey, RCLONE_CONFIG_WASABI_SECRET_ACCESS_KEY: c.secretKey,
        RCLONE_CONFIG_WASABI_REGION: c.region, RCLONE_CONFIG_WASABI_ENDPOINT: endpointOf(c.region),
      }),
    };
  }
  if (cfg) return null;
  if (fs.existsSync(LEGACY_CONF)) {
    return { kind: 'legacy', remote: LEGACY.remote, bucket: LEGACY.bucket, prefix: hostPrefix(), endpoint: LEGACY.endpoint,
      args: ['--config', LEGACY_CONF, '--s3-no-check-bucket'], env: Object.assign({}, process.env, { HOME: '/root' }) };
  }
  return null;
}
const base = (t) => t.remote + t.bucket + '/' + t.prefix;
function label(t) { return t ? t.bucket + '/' + t.prefix + ' · ' + t.endpoint + (t.kind === 'legacy' ? ' (rclone.conf)' : '') : null; }

// UI view: never the secret itself.
function view() {
  const c = get(), t = target();
  return {
    configured: configured(), accessKey: c ? c.accessKey : '', hasSecret: !!(c && c.secretKey), region: c ? c.region : 'eu-central-1',
    bucket: c ? c.bucket : '', prefix: c ? c.prefix : hostPrefix(), defaultPrefix: hostPrefix(), regions: REGIONS,
    target: t ? { kind: t.kind, label: label(t) } : null,
  };
}

// Round trip: list the bucket's top level, write and delete a marker in our folder.
async function test(execP) {
  const t = target();
  if (!t) throw Object.assign(new Error('Wasabi is not configured'), { status: 409 });
  const run = (args, timeout) => execP('rclone', [...t.args, ...args], { timeout: timeout || 60_000, env: t.env });
  const marker = base(t) + '/.rhc-test-' + Date.now();
  const steps = [];
  const ls = await run(['lsf', t.remote + t.bucket, '--max-depth', '1']);
  if (ls.err) return { ok: false, steps, error: 'list bucket: ' + oneLine(ls) };
  steps.push('bucket ' + t.bucket + ' reachable');
  const put = await execP('bash', ['-c', 'echo ok | rclone ' + t.args.map(q).join(' ') + ' rcat ' + q(marker)], { timeout: 60_000, env: t.env });
  if (put.err) return { ok: false, steps, error: 'write: ' + oneLine(put) };
  steps.push('write ok');
  const del = await run(['deletefile', marker]);
  if (del.err) return { ok: false, steps, error: 'delete: ' + oneLine(del) };
  steps.push('delete ok');
  return { ok: true, steps, target: label(t) };
}
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function oneLine(r) {
  const l = String(r.stderr || '').trim().split('\n').filter(Boolean);
  if (r.err && r.err.code === 'ENOENT') return 'rclone is not installed (apt install rclone)';
  return (l.slice(-1)[0] || (r.err && r.err.message) || 'failed').replace(/^.*?(ERROR|NOTICE)\s*:\s*/, '');
}

module.exports = { get, configured, save, clear, target, base, label, view, test, REGIONS };
