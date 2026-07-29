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
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
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
const USAGE_STALE_MS = 120 * 1000;

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1048576) {
    const v = n / 1048576;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + 'M';
  }
  if (n >= 1024) {
    const v = n / 1024;
    return (n < 102400 ? v.toFixed(1) : String(Math.round(v))) + 'k';
  }
  return String(Math.round(n));
}

// Countdown like kimi's /usage: two largest units, e.g. "1d 19h" / "2h 10m".
function fmtCountdown(resetTime) {
  const ms = Date.parse(resetTime || '');
  if (!Number.isFinite(ms)) return '';
  let s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
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
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 100 });
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
      timeout: 200,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let added = 0;
    let modified = 0;
    for (const line of out.split('\n')) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') { added++; continue; }
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
    const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
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
function sessionUsageSegment(sessionDir) {
  try {
    const agentsDir = path.join(sessionDir, 'agents');
    let input = 0;
    let output = 0;
    for (const agent of readdirSync(agentsDir)) {
      const wire = path.join(agentsDir, agent, 'wire.jsonl');
      if (!existsSync(wire)) continue;
      const text = readFileSync(wire, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.startsWith('{"type":"usage.record"')) continue;
        try {
          const u = JSON.parse(line).usage || {};
          input += (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
          output += u.output || 0;
        } catch { /* skip malformed line */ }
      }
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
  let cache = null;
  try {
    cache = JSON.parse(readFileSync(USAGE_CACHE, 'utf8'));
  } catch { /* no cache yet */ }
  if (cache === null || Date.now() - (cache.fetchedAt || 0) > USAGE_STALE_MS) {
    triggerUsageRefresh();
  }
  if (cache === null) return null;
  const parts = [];
  for (const [label, row] of [['周', cache.weekly], ['5h', cache.fiveHour]]) {
    if (!row || !row.limit) continue;
    const pct = Math.round((row.used / row.limit) * 100);
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
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh-usage'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* ignore */ }
}

// Refresh mode: fetch the managed /usages endpoint with the OAuth token kimi
// stores on disk, keep only what the status line needs, and write the cache.
async function refreshUsageCache() {
  try {
    const credPath = path.join(KIMI_HOME, 'credentials', 'kimi-code.json');
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    if (!cred.access_token) return;
    const base = (process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/usages`, {
      headers: { Authorization: `Bearer ${cred.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
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
    writeFileSync(USAGE_CACHE, JSON.stringify(out), { mode: 0o600 });
  } catch { /* keep the previous cache */ }
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
    const sessionDir = findSessionDir(p.sessionId);

    // 1. cwd + git branch + working-tree stats: ~ ⎇ main +2 ~1
    const cwdSeg = shortCwd(p.cwd);
    const gitSeg = p.gitBranch ? magenta(` ⎇ ${p.gitBranch}`) + gitStatsSegment(p.cwd) : '';
    if (cwdSeg || gitSeg) segs.push(dim(cwdSeg) + gitSeg);

    // 2. permission / plan mode
    if (p.planMode) segs.push(blue('plan'));
    else if (p.permissionMode === 'yolo') segs.push(boldYellow('yolo'));
    else if (p.permissionMode === 'auto') segs.push(boldRed('auto'));
    else segs.push(dim('manual'));

    // 3. model badge with thinking effort: [K3 ● max]
    const model = p.model || 'kimi';
    const effort = sessionDir ? currentEffort(sessionDir) : null;
    segs.push(cyan(`[${model}${effort ? ` ● ${effort}` : ''}]`));

    // 4. system memory bar: 内存 ███░░░░░░░ 49% (31G/64G)
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
    if (p.version) segs.push(dim(`Kimi v${p.version}`));

    process.stdout.write(segs.join(dim(' | ')) + '\n');
  });
}

if (process.argv[2] === '--refresh-usage') {
  refreshUsageCache().finally(() => process.exit(0));
} else {
  main().catch(() => process.exit(1));
}
