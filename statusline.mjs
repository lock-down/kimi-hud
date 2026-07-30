#!/usr/bin/env node
// kimi-code [status_line] command — claude-hud-style single-line footer.
// Receives a JSON snapshot on stdin: { model, cwd, gitBranch, permissionMode,
// planMode, contextUsage, contextTokens, maxContextTokens, sessionId, version }.
// Only the first stdout line is rendered (footer line 1). Exit nonzero on
// failure so kimi falls back to the built-in layout.
// thinkingEffort and session token usage are read from the session wire files
// located via sessionId. Plan usage (weekly / 5h limits) comes from the
// managed /usages endpoint through a cache file refreshed by a detached
// child process (`--refresh-usage`), so this script never blocks on network.

import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ESC = '\x1b[';
const reset = `${ESC}0m`;
const paint = (code, s) => `${ESC}${code}m${s}${reset}`;
const dim = (s) => paint('2', s);
const cyan = (s) => paint('36', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const blue = (s) => paint('34', s);
const magenta = (s) => paint('35', s);
const boldYellow = (s) => paint('1;33', s);
const boldRed = (s) => paint('1;31', s);

const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const USAGE_CACHE = path.join(KIMI_HOME, 'statusline-usage-cache.json');
const SESSION_USAGE_CACHE = path.join(KIMI_HOME, 'statusline-session-usage-cache.json');
const REFRESH_LOCK = path.join(KIMI_HOME, 'statusline-usage-refresh.lock');
const USAGE_STALE_MS = 120 * 1000;
const USAGE_MAX_AGE_MS = 24 * 3600 * 1000;
const REFRESH_LOCK_TTL_MS = 15 * 1000;

// Strip C0/C1 control chars and DEL from external strings (payload fields,
// wire values) so they cannot inject ANSI escapes or extra lines.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '');

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write tmp + rename so 1Hz readers never observe a torn cache file.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1048576) {
    const v = n / 1048576;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + 'M';
  }
  if (n >= 1024) {
    const k = n / 1024;
    if (k >= 100) {
      const r = Math.round(k);
      return r >= 1024 ? '1M' : `${r}k`;
    }
    const f = k.toFixed(1);
    return f === '100.0' ? '100k' : `${f}k`;
  }
  return String(Math.round(n));
}

// Countdown like kimi's /usage: two largest units, e.g. "1d 19h" / "2h 10m".
// Returns '' when the reset time has already passed.
function fmtCountdown(resetTime) {
  const ms = Date.parse(resetTime || '');
  if (!Number.isFinite(ms)) return '';
  let s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return '';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.length ? parts.join(' ') : '<1m';
}

function pctColor(pct) {
  return pct < 60 ? green : pct < 85 ? yellow : red;
}

// Approximate system RAM usage. macOS: total - (free + inactive + speculative).
function memorySegment() {
  try {
    const total = os.totalmem();
    let avail;
    if (process.platform === 'darwin') {
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 60 });
      const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 16384;
      const pages = (name) => Number(out.match(new RegExp(`${name}:\\s+(\\d+)\\.`))?.[1]) || 0;
      avail = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize;
    } else {
      avail = os.freemem();
    }
    const used = Math.max(0, total - avail);
    const g = (b) => Math.round(b / 1073741824);
    const pct = Math.round((used / total) * 100);
    return `${dim('内存')} ${pctColor(pct)(`${pct}%`)} ${dim(`(${g(used)}G/${g(total)}G)`)}`;
  } catch {
    return null;
  }
}

// Git working-tree stats: +N added (staged-new + untracked), ~N modified.
// Only called inside a repo (gated by payload gitBranch).
function gitStatsSegment(cwd) {
  try {
    const out = execSync('git --no-optional-locks status --porcelain=v1', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 150,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let added = 0;
    let modified = 0;
    for (const line of out.split('\n')) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') { added++; continue; }
      // Unmerged (conflict) entries: UU, AU, UA, DU, UD, AA — count as modified.
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A')) { modified++; continue; }
      if (x === 'A' || y === 'A') added++;
      else if ('MRTD'.includes(x) || 'MRTD'.includes(y)) modified++;
    }
    const parts = [];
    if (added > 0) parts.push(green(`+${added}`));
    if (modified > 0) parts.push(yellow(`~${modified}`));
    return parts.length ? ' ' + parts.join(' ') : '';
  } catch {
    return '';
  }
}

function shortCwd(cwd) {
  if (!cwd) return '';
  const home = os.homedir();
  let p = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
  const parts = p.split('/').filter(Boolean);
  if (parts.length > 2) p = (p.startsWith('~') ? '~/' : '') + parts.slice(-2).join('/');
  return p;
}

// Locate the session directory (…/sessions/<workdir-key>/session_<id>) from
// the payload's sessionId, which already carries the "session_" prefix.
function findSessionDir(sessionId) {
  if (!sessionId) return null;
  try {
    const sessionsRoot = path.join(KIMI_HOME, 'sessions');
    // The payload's sessionId already carries the "session_" prefix. Validate
    // before joining paths: the value arrives over stdin and must not be able
    // to escape the sessions root ("..", separators, control chars).
    const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
    if (!/^session_[A-Za-z0-9_-]+$/.test(dirName)) return null;
    for (const dir of readdirSync(sessionsRoot)) {
      const candidate = path.join(sessionsRoot, dir, dirName);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* fall through */ }
  return null;
}

// The payload has no effort field; every llm.request record in the main
// agent's wire file carries thinkingEffort, so the last one is the current
// value. Reads at most the last 2 MB. Returns null when unavailable.
function currentEffort(sessionDir) {
  try {
    const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const SLICE = 2 * 1024 * 1024;
    const size = statSync(wire).size;
    let text;
    if (size > SLICE) {
      const buf = Buffer.alloc(SLICE);
      const fd = openSync(wire, 'r');
      try {
        readSync(fd, buf, 0, SLICE, size - SLICE);
      } finally {
        closeSync(fd);
      }
      text = buf.toString('utf8');
    } else {
      text = readFileSync(wire, 'utf8');
    }
    const re = /"thinkingEffort":"([^"]+)"/g;
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    return last;
  } catch {
    return null;
  }
}

// Sum the session's usage.record events across every agent wire file.
// input = inputOther + inputCacheRead + inputCacheCreation — the same
// formula kimi's /usage uses for "Session usage".
// Wire files grow unbounded, so a sidecar cache remembers each wire's byte
// offset and running totals; every tick only reads the appended tail.
function sessionUsageSegment(sessionDir) {
  try {
    const agentsDir = path.join(sessionDir, 'agents');
    const raw = readJsonFile(SESSION_USAGE_CACHE);
    const cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const entry = cache[sessionDir] && typeof cache[sessionDir] === 'object' ? cache[sessionDir] : { wires: {}, touched: 0 };
    entry.touched = Date.now();
    entry.wires = entry.wires && typeof entry.wires === 'object' ? entry.wires : {};
    let input = 0;
    let output = 0;
    let dirty = false;
    for (const agent of readdirSync(agentsDir)) {
      const wire = path.join(agentsDir, agent, 'wire.jsonl');
      let size;
      try {
        size = statSync(wire).size;
      } catch {
        continue;
      }
      const w = entry.wires[wire] && typeof entry.wires[wire] === 'object'
        ? entry.wires[wire]
        : { offset: 0, input: 0, output: 0 };
      // Reset on truncation/rotation or corrupt cache values.
      if (!Number.isFinite(w.offset) || !Number.isFinite(w.input) || !Number.isFinite(w.output) || size < w.offset) {
        w.offset = 0;
        w.input = 0;
        w.output = 0;
      }
      if (size > w.offset) {
        const fd = openSync(wire, 'r');
        let chunk;
        try {
          const buf = Buffer.alloc(size - w.offset);
          readSync(fd, buf, 0, buf.length, w.offset);
          chunk = buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
        // Consume whole lines only; a partially-written tail is retried next tick.
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl !== -1) {
          const complete = chunk.slice(0, lastNl + 1);
          for (const line of complete.split('\n')) {
            if (!line.includes('"type":"usage.record"')) continue;
            try {
              const u = JSON.parse(line).usage || {};
              w.input += (Number(u.inputOther) || 0) + (Number(u.inputCacheRead) || 0) + (Number(u.inputCacheCreation) || 0);
              w.output += Number(u.output) || 0;
            } catch { /* skip malformed line */ }
          }
          w.offset += Buffer.byteLength(complete, 'utf8');
          dirty = true;
        }
      }
      entry.wires[wire] = w;
      input += w.input;
      output += w.output;
    }
    if (dirty) {
      cache[sessionDir] = entry;
      // Bound the sidecar: keep at most 20 most-recently-touched sessions.
      const keys = Object.keys(cache);
      if (keys.length > 20) {
        keys.sort((a, b) => (cache[a]?.touched || 0) - (cache[b]?.touched || 0));
        for (const k of keys.slice(0, keys.length - 20)) delete cache[k];
      }
      writeJsonAtomic(SESSION_USAGE_CACHE, cache);
    }
    if (input === 0 && output === 0) return null;
    return `${dim('会话')} in ${cyan(fmtTokens(input))} out ${magenta(fmtTokens(output))}`;
  } catch {
    return null;
  }
}

// Plan usage (weekly / 5h limits) rendered from the cache file; when the
// cache is stale or missing, kick off a detached refresh for the next tick.
function planUsageSegment() {
  const cache = readJsonFile(USAGE_CACHE);
  const fetchedAt = cache ? Number(cache.fetchedAt) : NaN;
  const age = Date.now() - fetchedAt;
  // Non-finite or out-of-window fetchedAt (corrupt file, clock skew) counts as stale.
  const stale = cache === null || !Number.isFinite(fetchedAt) || age < 0 || age > USAGE_STALE_MS;
  // Failed refreshes back off via retryAfter instead of touching fetchedAt,
  // so the displayed data's age stays honest.
  const retryAfter = cache ? Number(cache.retryAfter) || 0 : 0;
  if (stale && Date.now() >= retryAfter) triggerUsageRefresh();
  if (cache === null) return null;
  // Data older than the max age is no longer shown at all.
  if (Number.isFinite(age) && age >= 0 && age > USAGE_MAX_AGE_MS) return null;
  const parts = [];
  for (const [label, row] of [['周', cache.weekly], ['5h', cache.fiveHour]]) {
    if (!row || typeof row !== 'object') continue;
    const used = Number(row.used);
    const limit = Number(row.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) continue;
    const pct = Math.round((used / limit) * 100);
    const countdown = fmtCountdown(row.resetTime);
    parts.push(`${dim(label)} ${pctColor(pct)(`${pct}%`)}${countdown ? dim(` (${countdown})`) : ''}`);
  }
  return parts.length ? parts.join(' ') : null;
}

let usageRefreshSpawned = false;
function triggerUsageRefresh() {
  if (usageRefreshSpawned) return;
  usageRefreshSpawned = true;
  try {
    // Cross-process gate: each tick is a new process, so an in-process flag
    // alone cannot stop a spawn-per-second storm when refreshes keep failing.
    // The lock file (mtime TTL) suppresses concurrent/rapid refreshes.
    let locked = false;
    try {
      writeFileSync(REFRESH_LOCK, String(Date.now()), { flag: 'wx', mode: 0o600 });
      locked = true;
    } catch {
      try {
        const st = statSync(REFRESH_LOCK);
        if (Date.now() - st.mtimeMs < REFRESH_LOCK_TTL_MS) return; // a refresh is in flight
        writeFileSync(REFRESH_LOCK, String(Date.now()), { mode: 0o600 }); // steal stale lock
        locked = true;
      } catch { /* fall through */ }
    }
    if (!locked) return;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh-usage'], {
      detached: true,
      stdio: 'ignore',
    });
    // spawn reports async failures (EMFILE/EAGAIN) via the error event;
    // without a listener it would crash the render with uncaughtException.
    child.on('error', () => { /* never let a spawn failure fail the line */ });
    child.unref();
  } catch { /* ignore */ }
}

// Refresh mode: fetch the managed /usages endpoint with the OAuth token kimi
// stores on disk, keep only what the status line needs, and write the cache.
// On any failure write a negative cache (old data + fresh fetchedAt) so the
// next refresh is gated by USAGE_STALE_MS instead of retried every tick.
async function refreshUsageCache() {
  const rawPrev = readJsonFile(USAGE_CACHE);
  const prev = rawPrev && typeof rawPrev === 'object' && !Array.isArray(rawPrev) ? rawPrev : null;
  try {
    const credPath = path.join(KIMI_HOME, 'credentials', 'kimi-code.json');
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    if (!cred.access_token) throw new Error('no access token');
    const base = (process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/usages`, {
      headers: { Authorization: `Bearer ${cred.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    const pick = (row) => ({
      used: Number(row.used) || 0,
      limit: Number(row.limit) || 0,
      resetTime: typeof row.resetTime === 'string' ? row.resetTime : null,
    });
    const out = { fetchedAt: Date.now() };
    if (data.usage) out.weekly = pick(data.usage);
    if (Array.isArray(data.limits)) {
      for (const entry of data.limits) {
        const w = entry?.window || {};
        const isFiveHour =
          (w.timeUnit === 'TIME_UNIT_MINUTE' && Number(w.duration) === 300) ||
          (w.timeUnit === 'TIME_UNIT_HOUR' && Number(w.duration) === 5);
        if (isFiveHour && entry.detail) out.fiveHour = pick(entry.detail);
      }
    }
    writeJsonAtomic(USAGE_CACHE, out);
  } catch {
    // Negative cache: keep the old data and its original fetchedAt (the
    // data's age must stay honest), only push the next retry out.
    writeJsonAtomic(USAGE_CACHE, { ...(prev || {}), retryAfter: Date.now() + USAGE_STALE_MS });
  }
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    const timer = setTimeout(() => rejectPromise(new Error('stdin timeout')), 200);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolvePromise(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); rejectPromise(err); });
  });
}

function main() {
  return readStdin().then((raw) => {
    const p = JSON.parse(raw);
    const segs = [];
    const sessionDir = findSessionDir(clean(p.sessionId));

    // 1. cwd + git branch + working-tree stats: ~ ⎇ main +2 ~1
    const cwdSeg = shortCwd(clean(p.cwd));
    const gitBranch = clean(p.gitBranch);
    const gitSeg = gitBranch ? magenta(` ⎇ ${gitBranch}`) + gitStatsSegment(p.cwd) : '';
    if (cwdSeg || gitSeg) segs.push(dim(cwdSeg) + gitSeg);

    // 2. permission / plan mode
    if (p.planMode) segs.push(blue('plan'));
    else if (p.permissionMode === 'yolo') segs.push(boldYellow('yolo'));
    else if (p.permissionMode === 'auto') segs.push(boldRed('auto'));
    else segs.push(dim('manual'));

    // 3. model badge with thinking effort: [K3 ● max]
    const model = clean(p.model) || 'kimi';
    const effort = sessionDir ? clean(currentEffort(sessionDir)) : '';
    segs.push(cyan(`[${model}${effort ? ` ● ${effort}` : ''}]`));

    // 4. system memory: 内存 47% (30G/64G)
    const mem = memorySegment();
    if (mem) segs.push(mem);

    // 5. session token usage: 会话 in 7.1M out 52.9k
    if (sessionDir) {
      const su = sessionUsageSegment(sessionDir);
      if (su) segs.push(su);
    }

    // 6. plan usage: 周 23% (1d 19h) 5h 20% (2h 10m)
    const pu = planUsageSegment();
    if (pu) segs.push(pu);

    // 7. kimi-code version
    const version = clean(p.version);
    if (version) segs.push(dim(`Kimi v${version}`));

    process.stdout.write(segs.join(dim(' | ')) + '\n');
  });
}

if (process.argv[2] === '--refresh-usage') {
  refreshUsageCache().finally(() => {
    try { unlinkSync(REFRESH_LOCK); } catch { /* lock may belong to another run */ }
    process.exit(0);
  });
} else {
  main().catch(() => process.exit(1));
}
