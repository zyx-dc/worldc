#!/usr/bin/env node
// 当 github.com 的 git 端点被代理挡掉、但 api.github.com 还能用时，
// 走 REST API 把本地内容推上去。用法：node tools/push-api.mjs
//
// 它按**内容**推，不按提交历史推：
//   比较本地 HEAD 的文件表与远端 main 的文件表，只上传 sha 变了的文件，
//   再以「远端 main」为父提交建一个新提交。
//
// 为什么必须这样：本地 origin/main 可能已经落后（fetch 也走 git 端点，一样被挡），
// 拿它当父提交会把中间那些提交整个抹掉。以远端为父，历史永远是线性的。
//
// 代价：API 生成的提交 sha 和本地不同（GitHub 会归一化 author/committer），
// 网络恢复后要 git fetch && git reset --hard origin/main 对齐一次。
// 内容不会丢 —— 每个文件都先比过 sha。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();

const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);

// GET 不能带 --input（gh 会当成请求体发出去，GitHub 回 404），必须分开
const apiGet = (path) => JSON.parse(run('gh', ['api', path]));
const apiSend = (path, method, body) =>
  JSON.parse(run('gh', ['api', path, '-X', method, '--input', '-'], JSON.stringify(body)));

// ── 1. 两边各自的文件表（path → blob sha） ──────────────────
const local = new Map();
for (const line of run('git', ['ls-tree', '-r', 'HEAD']).split('\n')) {
  const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
  if (m) local.set(m[2], m[1]);
}

const head = apiGet(`repos/${repo}/commits/main`);
const remote = new Map();
for (const e of apiGet(`repos/${repo}/git/trees/${head.commit.tree.sha}?recursive=1`).tree) {
  if (e.type === 'blob') remote.set(e.path, e.sha);
}

// ── 2. 差异 ─────────────────────────────────────────────────
const put = [];
const del = [];
for (const [path, sha] of local) if (remote.get(path) !== sha) put.push(path);
for (const path of remote.keys()) if (!local.has(path)) del.push(path);

if (!put.length && !del.length) {
  console.log('  内容已一致，无需推送');
  process.exit(0);
}
console.log(`  远端 ${head.sha.slice(0, 7)} · 需上传 ${put.length} 个文件${del.length ? ` · 删除 ${del.length} 个` : ''}`);

// ── 3. 上传 blob、建树 ──────────────────────────────────────
const entries = [];
for (const path of put) {
  const content = readFileSync(path);
  const blob = apiSend(`repos/${repo}/git/blobs`, 'POST', {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`    ↑ ${path}  ${content.length} B`);
}
for (const path of del) {
  entries.push({ path, mode: '100644', type: 'blob', sha: null });
  console.log(`    ✕ ${path}`);
}

const tree = apiSend(`repos/${repo}/git/trees`, 'POST', { base_tree: head.commit.tree.sha, tree: entries });

// ── 4. 提交并移动 ref ───────────────────────────────────────
const message = run('git', ['log', '-1', '--pretty=%B']);
const commit = apiSend(`repos/${repo}/git/commits`, 'POST', {
  message,
  tree: tree.sha,
  parents: [head.sha],
});
apiSend(`repos/${repo}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });

console.log(`  已推送 ${commit.sha.slice(0, 7)} → main`);
console.log('  网络恢复后：git fetch origin && git reset --hard origin/main');
