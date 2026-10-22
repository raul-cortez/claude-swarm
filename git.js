// git.js — all git plumbing for the branch status bar and the diff counter.
// Pure Node on purpose (child_process + fs, no Electron), so it can be required
// from a plain `node -e` script and main.js just wires the IPC.
//
// Every command runs via execFile (no shell → a branch name can't inject) and
// is forced non-interactive so it can NEVER hang or pop a login window from this
// background process — it fails fast and the renderer shows a friendly "log in"
// modal. The three knobs, cross-platform:
//   GIT_TERMINAL_PROMPT=0            — no terminal username/password prompt (all OS)
//   GIT_SSH_COMMAND=ssh -oBatchMode=yes — no ssh passphrase prompt (all OS)
//   -c credential.interactive=false  — stops Windows' Git Credential Manager from
//                                      popping its GUI login (esp. on auto-fetch)
// We deliberately do NOT set GIT_ASKPASS: the old value 'echo' is a shell builtin
// with no .exe on Windows, so git errored trying to spawn it. The knobs above are
// enough. Auth itself is inherited from the same environment the terminal uses
// (Keychain / ssh-agent / GCM), so cached creds just work. No UI login by design.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// numstat parsing is shared with the renderer's diff overlay — one parser, one
// set of tests (test/diff.test.js). diffview.js is dual-mode, so requiring it
// from plain Node here works exactly as it does from the tests.
const { parseNumstatZ } = require('./renderer/diffview');

const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

// Run a git subcommand in cwd. Never rejects — resolves { code, stdout, stderr }.
// code 0 = success; anything else (non-zero exit, ENOENT, timeout) = failure.
function runGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'credential.interactive=false', ...args], {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...NO_PROMPT_ENV },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

// { isRepo, branch, ahead, behind, dirty, worktree } (worktree: see worktreeInfo). Non-repo / no git → { isRepo:false }.
async function gitInfo(cwd) {
  if (!cwd) return { isRepo: false };
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout !== 'true') return { isRepo: false };

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = head.stdout || 'HEAD';
  if (branch === 'HEAD') { // detached — show a short hash instead
    const short = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    branch = short.code === 0 && short.stdout ? `(${short.stdout})` : 'HEAD';
  }

  const status = await runGit(cwd, ['status', '--porcelain']);
  const dirty = status.stdout.length > 0;

  let ahead = 0, behind = 0;
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts.code === 0) { // no upstream → non-zero exit → leaves both 0
    const [l, r] = counts.stdout.split(/\s+/);
    behind = Number(l) || 0; // upstream has it, HEAD doesn't → behind
    ahead = Number(r) || 0;  // HEAD has it, upstream doesn't → ahead
  }

  const worktree = await worktreeInfo(cwd, head.stdout);
  return { isRepo: true, branch, ahead, behind, dirty, worktree };
}

// --- worktrees ---------------------------------------------------------------
// An agent often leaves the tab's folder for a worktree of its own, and the bar follows it
// there (main.js tracks where the agent actually works). In a worktree the bar also answers
// «is this work in yet»: how many commits of the branch the branch it was cut from doesn't
// have.
//
// Git doesn't remember what a branch was cut from — the reflog only says «Created from HEAD».
// So we remember it ourselves, as a key in the branch's own config section:
// branch.<name>.swarmBase. It survives tabs and restarts, and git drops it together with the
// branch. Deliberately NOT the upstream: with a local upstream a bare `git push` from the
// worktree would rewrite that local branch.
const BASE_KEY = 'swarmBase';

// Linked worktree → { root, base, unmerged }; the main checkout or a non-repo → null.
// unmerged is null when there's nothing to compare with (detached HEAD, no base).
async function worktreeInfo(cwd, branch) {
  const dirs = await runGit(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']);
  if (dirs.code !== 0) return null;
  const [gitDir, commonRaw, root] = dirs.stdout.split(/\r?\n/);
  if (!gitDir || !commonRaw) return null;
  // Real paths on both sides: a cwd reached through a symlink (/tmp → /private/tmp on a Mac)
  // would otherwise make the main checkout look like a worktree of itself.
  if (realPath(path.resolve(cwd, commonRaw)) === realPath(gitDir)) return null; // the main checkout
  const out = { root: root || cwd, base: null, unmerged: null };
  if (!branch || branch === 'HEAD') return out;

  out.base = await worktreeBase(cwd, branch);
  if (out.base) out.unmerged = await unmergedCount(cwd, out.base);
  return out;
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

// The branch this one was cut from. Remembered on first sight: main.js asks as soon as it
// sees the agent enter the worktree, and at that moment the main checkout still sits on the
// branch the worktree was cut from. A worktree made without us gets the same guess the first
// time the bar shows it.
async function worktreeBase(cwd, branch) {
  const key = `branch.${branch}.${BASE_KEY}`;
  const saved = await runGit(cwd, ['config', '--get', key]);
  if (saved.code === 0 && saved.stdout) return saved.stdout;

  const list = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  // The first record is always the main checkout.
  const first = list.code === 0 ? list.stdout.split(/\r?\n\r?\n/)[0] : '';
  const m = /^branch refs\/heads\/(.+)$/m.exec(first || '');
  if (m && m[1] !== branch) {
    await runGit(cwd, ['config', key, m[1]]);
    return m[1];
  }
  // Main checkout detached: compare with the remote's default branch, but don't remember
  // it — a better answer may turn up once the main checkout is back on a branch.
  const remote = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return remote.code === 0 && remote.stdout ? remote.stdout : null;
}

// Commits of HEAD the base doesn't have. A squash or rebase merge leaves the commits
// themselves out of the base, so when everything they changed already reads the same in the
// base, the work is in and the count is 0.
async function unmergedCount(cwd, base) {
  const ok = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (ok.code !== 0) return null;
  const count = await runGit(cwd, ['rev-list', '--count', `${base}..HEAD`]);
  if (count.code !== 0) return null;
  const n = Number(count.stdout) || 0;
  if (!n) return 0;
  const names = await runGit(cwd, ['diff', '--name-only', '-z', `${base}...HEAD`]);
  if (names.code !== 0) return n;
  const files = names.stdout.split('\0').filter(Boolean);
  if (!files.length) return 0;
  const same = await runGit(cwd, ['diff', '--quiet', base, 'HEAD', '--', ...files]);
  return same.code === 0 ? 0 : n;
}

// Local branch names, most-recently-committed first (--sort=-committerdate) —
// the branches you're actively working on float to the top, like editors do.
// Caller marks which one is current (from gitInfo.branch).
async function gitBranches(cwd) {
  if (!cwd) return [];
  const res = await runGit(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).filter(Boolean);
}

// Shape every mutating action the same way: { ok, error }.
function actionResult(res, fallback) {
  return { ok: res.code === 0, error: res.code === 0 ? null : (res.stderr || res.stdout || fallback) };
}

async function gitCheckout(cwd, branch) {
  return actionResult(await runGit(cwd, ['checkout', branch]), 'не удалось переключиться');
}

// Network op → longer timeout. --prune drops refs deleted on the remote.
async function gitFetch(cwd) {
  return actionResult(await runGit(cwd, ['fetch', '--prune'], 20000), 'не удалось обновить');
}

// --ff-only: never create a merge commit or leave a conflict behind our back.
// If it can't fast-forward, git errors and we surface it (user resolves in the terminal).
async function gitPull(cwd) {
  return actionResult(await runGit(cwd, ['pull', '--ff-only'], 20000), 'не удалось подтянуть');
}

// --- untracked files ---------------------------------------------------------
// New files are invisible to `git diff HEAD`, but Claude creates them constantly
// — a fresh 200-line file would read as +0. We count them ourselves rather than
// shelling out per file (`git diff --no-index` takes exactly two paths, so 50 new
// files would mean 50 processes every 2.5s). Bonus: no /dev/null, which is a
// cross-platform sore spot on Windows.

const SNIFF_BYTES = 8192;          // how much of a file we read to guess binary
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024; // past this we don't count, we say so

// Same heuristic git itself uses: a NUL byte early in the file means binary.
function isBinaryBuffer(buf) {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

// Lines as a diff would count them: a trailing newline does not open a new line,
// and a last line without one still counts. CR is part of the line, not a break.
function countLines(buf) {
  if (!buf.length) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++; // unterminated last line
  return n;
}

// The empty tree. Diffing against it makes a repo with NO commits work (there
// `git diff HEAD` just fails — HEAD does not exist yet), so the very first
// commit's worth of work shows up as changes instead of an error.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// mtime+size → { added, binary, big }. Steady-state polling then costs a stat()
// per untracked file, not a full read.
const untrackedCache = new Map();

async function diffBase(cwd) {
  const head = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  return head.code === 0 ? 'HEAD' : EMPTY_TREE;
}

// One untracked file → { added, binary, big }. Never throws: an unreadable file
// (deleted between listing and stat, permissions) counts as nothing.
function statUntracked(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return null; }
  if (!st.isFile()) return null;

  const key = st.mtimeMs + ':' + st.size;
  const hit = untrackedCache.get(abs);
  if (hit && hit.key === key) return hit.val;

  let val;
  if (st.size > MAX_UNTRACKED_BYTES) {
    val = { added: 0, binary: false, big: true };
  } else {
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    val = isBinaryBuffer(buf)
      ? { added: 0, binary: true, big: false }
      : { added: countLines(buf), binary: false, big: false };
  }
  untrackedCache.set(abs, { key, val });
  return val;
}

// Every untracked file in cwd, already .gitignore-filtered by git itself.
// -uall lists files inside new folders individually (the default collapses them
// to 'dir/', which we could not count); -z keeps unicode/spaced paths unquoted.
async function untrackedFiles(cwd) {
  const res = await runGit(cwd, ['status', '--porcelain', '-uall', '-z']);
  if (res.code !== 0) return [];
  const out = [];
  for (const rec of res.stdout.split('\0')) {
    if (rec.slice(0, 2) !== '??') continue;
    const rel = rec.slice(3);
    if (rel) out.push(rel);
  }
  return out;
}

// { added, removed, files: [{ path, oldPath, added, removed, status, binary, big }] }.
// Tracked changes come from `git diff <base> --numstat -z`; untracked ones are
// appended as pure additions (status 'added'). Non-repo / git failure → nulls,
// so the caller just hides the counter, matching how the branch bar stays hidden.
//
// With `since` (a worktree's base branch) it's the branch's committed work instead: what
// HEAD changed since it forked from `since` — the diff a merge would bring in.
async function gitDiffStat(cwd, since) {
  if (!cwd) return { added: 0, removed: 0, files: [] };
  if (since) {
    const res = await runGit(cwd, ['diff', `${since}...HEAD`, '--numstat', '-z']);
    if (res.code !== 0) return { added: 0, removed: 0, files: [] };
    return sumFiles(parseNumstatZ(res.stdout));
  }
  const base = await diffBase(cwd);
  const res = await runGit(cwd, ['diff', base, '--numstat', '-z']);
  if (res.code !== 0) return { added: 0, removed: 0, files: [] };

  const files = parseNumstatZ(res.stdout);

  const seen = new Set();
  for (const rel of await untrackedFiles(cwd)) {
    const abs = path.join(cwd, rel);
    seen.add(abs);
    const info = statUntracked(abs);
    if (!info) continue;
    files.push({
      path: rel,
      oldPath: null,
      added: info.added,
      removed: 0,
      status: info.binary ? 'binary' : 'added',
      binary: info.binary,
      big: info.big,
    });
  }
  // Evict cache entries for THIS repo that are no longer untracked (committed,
  // deleted, or newly .gitignored) — otherwise the map grows unbounded over a
  // long session. Scoped by cwd prefix so other repos' entries survive; the
  // trailing sep keeps /a from matching a sibling /a-b.
  const prefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  for (const abs of untrackedCache.keys()) {
    if (abs.startsWith(prefix) && !seen.has(abs)) untrackedCache.delete(abs);
  }

  return sumFiles(files);
}

function sumFiles(files) {
  let added = 0, removed = 0;
  for (const f of files) { added += f.added; removed += f.removed; }
  return { added, removed, files };
}

// Unified diff of ONE file, as text. Lazy by design — the overlay asks for a
// file only when you click it.
//
// An untracked file has no diff to ask git for, so we synthesise it: every line
// is an addition. This is also why gitDiffStat counts them with fs — the two
// stay consistent, and `git diff --no-index /dev/null <file>` (a Windows sore
// spot) never enters the picture.
async function gitDiffText(cwd, rel, since) {
  if (!cwd || !rel) return '';
  if (since) {
    const res = await runGit(cwd, ['diff', `${since}...HEAD`, '--', rel]);
    return res.code === 0 ? res.stdout : '';
  }

  const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '-z', '--', rel]);
  if (tracked.code === 0) {
    const base = await diffBase(cwd);
    // -- <path> after a '--' separator: a file named like a flag can't be
    // mistaken for one. No -z here: we want the human-readable unified text.
    const res = await runGit(cwd, ['diff', base, '--', rel]);
    return res.code === 0 ? res.stdout : '';
  }

  const info = statUntracked(path.join(cwd, rel));
  if (!info || info.binary || info.big) return '';
  let buf;
  try { buf = fs.readFileSync(path.join(cwd, rel)); } catch (_) { return ''; }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing \n
  const body = lines.map((l) => '+' + (l.endsWith('\r') ? l.slice(0, -1) : l));
  const tail = text.endsWith('\n') ? [] : ['\\ No newline at end of file'];
  return ['@@ -0,0 +1,' + lines.length + ' @@', ...body, ...tail].join('\n');
}

module.exports = {
  runGit, gitInfo, gitBranches, gitCheckout, gitFetch, gitPull,
  isBinaryBuffer, countLines, gitDiffStat, gitDiffText,
};
