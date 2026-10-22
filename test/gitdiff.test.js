// Unit tests for git.js' pure untracked-file helpers (run node test/gitdiff.test.js).
// The untracked-file helpers are pure buffer math, which is where the NaN/binary bugs live;
// the worktree part at the bottom runs against a real throwaway repo.
const assert = require('assert');
const G = require('../git');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('isBinaryBuffer spots a NUL byte', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.from([0x61, 0x00, 0x62])), true);
});

test('isBinaryBuffer passes plain text, including unicode', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.from('const x = 1;\nпривет\n', 'utf8')), false);
});

test('isBinaryBuffer only sniffs the first 8KB', () => {
  const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
  assert.strictEqual(G.isBinaryBuffer(buf), false); // NUL sits past the sniff window
});

test('isBinaryBuffer treats an empty buffer as text', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.alloc(0)), false);
});

test('countLines counts newline-terminated lines', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\nb\nc\n', 'utf8')), 3);
});

test('countLines counts a last line with no trailing newline', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\nb\nc', 'utf8')), 3);
});

test('countLines handles CRLF without double-counting', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\r\nb\r\n', 'utf8')), 2);
});

test('countLines of an empty file is 0', () => {
  assert.strictEqual(G.countLines(Buffer.alloc(0)), 0);
});

// --- worktrees: a real throwaway repo ------------------------------------------
// These do call git: what's under test is git's own answers (which dir is a worktree, what
// a squash merge leaves behind), and faking them would test nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wt-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
  git(root, 'init', '-q', '-b', 'develop');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'start');
  const wt = path.join(root, '.claude', 'worktrees', 'x');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-x', wt);
  return { root, wt, git, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the main checkout is not a worktree, a linked one is', async () => {
  const sb = sandbox();
  try {
    assert.strictEqual((await G.gitInfo(sb.root)).worktree, null);
    const w = (await G.gitInfo(sb.wt)).worktree;
    assert.ok(w, 'linked worktree recognised');
    assert.strictEqual(fs.realpathSync(w.root), fs.realpathSync(sb.wt));
  } finally { sb.done(); }
});

test('the base is the main checkout\'s branch, remembered in the branch config', async () => {
  const sb = sandbox();
  try {
    assert.strictEqual((await G.gitInfo(sb.wt)).worktree.base, 'develop');
    assert.strictEqual(sb.git(sb.root, 'config', '--get', 'branch.worktree-x.swarmBase'), 'develop');
    // The main checkout moves on — the remembered base doesn't.
    sb.git(sb.root, 'checkout', '-q', '-b', 'other');
    assert.strictEqual((await G.gitInfo(sb.wt)).worktree.base, 'develop');
  } finally { sb.done(); }
});

test('unmerged counts the branch\'s commits and drops to 0 after a squash merge', async () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.wt, 'f'), 'a\n');
    sb.git(sb.wt, 'add', 'f'); sb.git(sb.wt, 'commit', '-q', '-m', 'one');
    fs.appendFileSync(path.join(sb.wt, 'f'), 'b\n');
    sb.git(sb.wt, 'commit', '-q', '-am', 'two');
    assert.strictEqual((await G.gitInfo(sb.wt)).worktree.unmerged, 2);
    const stat = await G.gitDiffStat(sb.wt, 'develop');
    assert.deepStrictEqual([stat.added, stat.removed, stat.files.length], [2, 0, 1]);
    sb.git(sb.root, 'merge', '-q', '--squash', 'worktree-x');
    sb.git(sb.root, 'commit', '-q', '-m', 'squashed');
    assert.strictEqual((await G.gitInfo(sb.wt)).worktree.unmerged, 0);
  } finally { sb.done(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
