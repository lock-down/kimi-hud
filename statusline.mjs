#!/usr/bin/env node
// kimi-code [status_line] command — claude-hud-style single-line footer.
// Receives a JSON snapshot on stdin: { model, cwd, gitBranch, permissionMode,
// planMode, contextUsage, contextTokens, maxContextTokens, sessionId, version }.
// Only the first stdout line is rendered (footer line 1). Exit nonzero on
// failure so kimi falls back to the built-in layout.
// thinkingEffort is not in the payload; it is read from the session wire file
// (last llm.request record) located via sessionId.

import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';

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

function usageBar(ratio, width = 10) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = `${Math.round(r * 100)}%`;
  const color = r < 0.6 ? green : r < 0.85 ? yellow : red;
  return color(`${bar} ${pct}`);
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
    return `${dim('内存')} ${usageBar(used / total)} ${dim(`(${g(used)}G/${g(total)}G)`)}`;
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

// The payload has no effort field; every llm.request record in the session
// wire file carries thinkingEffort, so the last one is the current value.
// Reads at most the last 2 MB. Returns null when unavailable.
function currentEffort(sessionId) {
  if (!sessionId) return null;
  try {
    const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const sessionsRoot = path.join(home, 'sessions');
    // The payload's sessionId already carries the "session_" prefix.
    const sessionDir = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
    for (const dir of readdirSync(sessionsRoot)) {
      const wire = path.join(sessionsRoot, dir, sessionDir, 'agents', 'main', 'wire.jsonl');
      if (!existsSync(wire)) continue;
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
    }
  } catch {
    return null;
  }
  return null;
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
    const effort = currentEffort(p.sessionId);
    segs.push(cyan(`[${model}${effort ? ` ● ${effort}` : ''}]`));

    // 4. system memory bar: 内存 ███░░░░░░░ 49% (31G/64G)
    const mem = memorySegment();
    if (mem) segs.push(mem);

    // 5. kimi-code version
    if (p.version) segs.push(dim(`Kimi v${p.version}`));

    process.stdout.write(segs.join(dim(' | ')) + '\n');
  });
}

main().catch(() => process.exit(1));
