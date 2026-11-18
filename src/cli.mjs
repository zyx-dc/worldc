#!/usr/bin/env node
// worldc —— 世界编译器 CLI
//   node src/cli.mjs import https://space.bilibili.com/<mid>/favlist?fid=<fid>
//   node src/cli.mjs build examples/my-favorites.world --items-from cache/x.items.json
//   node src/cli.mjs build examples/my-favorites.world --out build/scene.json
//   node src/cli.mjs diff examples/a.world examples/b.world

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { parseWorld } from './parse.mjs';
import { compile, canonical, diff } from './compile.mjs';
import { renderPlan } from './render/plan.mjs';
import { mockItems } from './adapters/mock.mjs';
import { parseFavTarget, fetchFolder, listFolders } from './adapters/bilibili.mjs';
import { buildWorldFromItems, mergeWorld } from './importer.mjs';

const RULE = '─'.repeat(58);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function loadWorld(path) {
  const src = readFileSync(path, 'utf8');
  const world = parseWorld(src);
  return { world, src };
}

/**
 * items 从哪来：显式缓存文件 > world 同名的 .items.json > mock
 */
function loadItems(world, worldPath) {
  const explicit = arg('--items-from', null);
  const guess = worldPath.replace(/\.world$/, '.items.json');
  const candidates = [explicit, guess].filter(Boolean);

  for (const p of candidates) {
    try {
      const items = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(items) && items.length) return { items, from: p };
    } catch { /* 下一个 */ }
  }

  const n = Number(arg('--items', world.items ?? 120));
  return { items: mockItems(n, `mock-v1:${n}`), from: `mock(${n})` };
}

function shortKey(k) {
  const s = String(k);
  return s.length > 15 ? s.slice(0, 15) : s;
}

function pad(s, n) {
  return String(s).padEnd(n, ' ');
}

function cmdBuild() {
  const path = process.argv[3];
  if (!path) throw new Error('用法：worldc build <file.world>');

  const t0 = process.hrtime.bigint();
  const { world, src } = loadWorld(path);
  const { items, from } = loadItems(world, path);
  const { ir, hash, stats } = compile(world, items);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log('');
  console.log('  worldc · 世界编译器 v0.1');
  console.log('  ' + RULE);
  console.log(`  ${pad('world', 8)}${world.name}`);
  console.log(`  ${pad('source', 8)}${world.source}`);
  console.log(`  ${pad('seed', 8)}0x${world.seed.toString(16)}`);
  console.log(`  ${pad('parse', 8)}${path} · ${src.split('\n').length} 行 · ${(Buffer.byteLength(src) / 1024).toFixed(1)} KB`);
  console.log(`  ${pad('items', 8)}${stats.items}${from.startsWith('mock') ? '  (mock)' : '  ← ' + from}`);
  console.log(`  ${pad('regions', 8)}${stats.regions}`);
  for (const r of ir.regions) {
    const span = `${r.years[0]}-${r.years[1]}`;
    const grid = `${r.layout.rows}×${r.layout.cols}`;
    console.log(`  ${' '.repeat(8)}▸ ${pad(r.name, 12)}${pad(span, 10)}hue ${pad(r.hue, 5)}grid ${pad(grid, 7)}${r.exhibits.length} 件`);
  }
  console.log(`  ${pad('layout', 8)}推导 ${stats.placed} 件 · 覆盖 ${stats.pinned} 件 · 算法 v${stats.layout}${stats.overflow ? ` · 溢出 ${stats.overflow} 件` : ''}${stats.unplaced ? ` · 未归位 ${stats.unplaced} 件（跑 import --merge）` : ''}`);
  console.log(`  ${pad('ir', 8)}空间图 ${stats.placed} 节点 · ${(stats.bytes / 1024).toFixed(1)} KB`);
  console.log(`  ${pad('hash', 8)}sha256 ${hash.slice(0, 16)}…${hash.slice(-6)}`);
  console.log(`  ${pad('time', 8)}${ms.toFixed(1)} ms`);
  console.log('');

  const out = arg('--out', null);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(ir, null, 1), 'utf8');

    // 同时把源码和素材放到场景图旁边：编辑器需要它们才能实时重编译
    const base = out.replace(/\.json$/, '');
    writeFileSync(`${base}.world`, src, 'utf8');
    writeFileSync(`${base}.items.json`, JSON.stringify(items), 'utf8');

    console.log(`  已写出 ${out}  ·  ${(Buffer.byteLength(canonical(ir)) / 1024).toFixed(1)} KB`);
    console.log(`         ${base}.world  +  ${base}.items.json`);
    console.log('');
  }

  return { ir, hash, stats };
}

function cmdDiff() {
  const a = process.argv[3];
  const b = process.argv[4];
  if (!a || !b) throw new Error('用法：worldc diff <a.world> <b.world>');

  const A0 = loadWorld(a);
  const B0 = loadWorld(b);

  // 两边各用各的快照。收藏夹更新后 b 会比 a 多几条，
  // 用 a 的快照去编译 b 会立刻报「place 引用了不存在的展品」。
  const itemsA = loadItems(A0.world, a);
  const explicit = arg('--items-from', null);
  const bLoaded = explicit ? itemsA : loadItems(B0.world, b);
  const itemsB = bLoaded.from.startsWith('mock(') ? itemsA : bLoaded;

  const A = compile(A0.world, itemsA.items);
  const B = compile(B0.world, itemsB.items);
  const d = diff(A.ir, B.ir);

  console.log('');
  console.log('  worldc · 空间 diff');
  console.log('  ' + RULE);
  console.log(`  a       ${a}  ${A.hash.slice(0, 12)}`);
  console.log(`  b       ${b}  ${B.hash.slice(0, 12)}`);
  console.log(`  moved   ${d.moved.length} 件`);
  console.log(`  rotated ${d.rotated.length} 件`);
  console.log(`  region  ${d.regionChanged.length} 件`);
  console.log(`  gone    ${d.gone.length} 件`);
  console.log(`  added   ${d.added.length} 件`);
  if (d.rotated.length) {
    const top = d.rotated.slice().sort((x, y) => y.delta - x.delta).slice(0, 3);
    for (const m of top) console.log(`          ${pad(shortKey(m.id), 16)}转了 ${m.delta}°  ${m.from} → ${m.to}`);
  }
  if (d.moved.length) {
    const top = d.moved.slice().sort((x, y) => y.distance - x.distance).slice(0, 5);
    for (const m of top) {
      console.log(`          ${pad(shortKey(m.id), 16)}${pad(m.region, 12)}位移 ${m.distance}`);
    }
  }
  console.log('');
}

function cmdPlan() {
  const path = process.argv[3];
  if (!path) throw new Error('用法：worldc plan <file.world> [--out build/plan.svg]');

  const { world } = loadWorld(path);
  const { items } = loadItems(world, path);
  const { ir, hash } = compile(world, items);
  ir.__hash = hash.slice(0, 16);

  const svg = renderPlan(ir);
  const out = arg('--out', 'build/plan.svg');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, svg, 'utf8');

  const nodes = ir.regions.reduce((s, r) => s + r.exhibits.length, 0);
  console.log('');
  console.log('  worldc · 2D 后端');
  console.log('  ' + RULE);
  console.log(`  ir      ${nodes} 节点  ${hash.slice(0, 16)}`);
  console.log(`  out     ${out}  ·  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);
  console.log('');
}

async function cmdImport() {
  const target = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const fromItems = arg('--from-items', null);
  const doMerge = process.argv.includes('--merge');

  if (!target && !fromItems) {
    console.log('  用法：');
    console.log('    worldc import <收藏夹链接 | "mid fid"> [--max 240] [--out x.world]');
    console.log('    worldc import --from-items x.items.json [--merge] [--out x.world]');
    throw new Error('缺少输入');
  }

  let items;
  let partial = false;
  let partialNote = '';
  let title = arg('--title', null);
  let source = arg('--source', null);
  let fid = null;

  if (fromItems) {
    // 离线：直接用本地快照，不联网。重放与测试都靠它。
    items = JSON.parse(readFileSync(fromItems, 'utf8'));
    source = source || fromItems;
    title = title || '未命名收藏夹';
  } else {
    const parsed = parseFavTarget(target);
    fid = parsed.fid;
    const owner = parsed.mid;

    // 只给了 mid：列出这个人的公开收藏夹，挑第一个
    if (!fid && owner) {
      const folders = await listFolders(owner);
      if (!folders.length) throw new Error(`用户 ${owner} 没有公开收藏夹`);
      fid = folders[0].fid;
      console.log(`\n  ${owner} 的公开收藏夹：`);
      for (const f of folders.slice(0, 8)) console.log(`    ${f.fid}  ${pad(f.title, 18)}${f.count} 件`);
      console.log(`  → 选用 ${folders[0].title}\n`);
    }
    if (!fid) throw new Error('解析不出收藏夹 id');

    const max = Number(arg('--max', 240));
    const res = await fetchFolder(fid, { mid: owner, max });
    items = res.items;
    partial = res.partial;
    partialNote = res.note;
    title = title || res.info.title;
    source = source || `bilibili/fav/${fid}${owner ? `?mid=${owner}` : ''}`;
    if (!items.length) throw new Error('这个收藏夹没有可读内容（可能是私密收藏夹）');
  }

  const out = arg('--out', fid ? `examples/fav-${fid}.world` : null);
  if (!out) throw new Error('--from-items 模式需要用 --out 指定输出文件');
  const cachePath = out.replace(/\.world$/, '.items.json');

  // ── 合并：读旧源码 + 旧快照，保留每一个已有格位 ──
  let result;
  let stats = null;

  if (doMerge && partial) {
    // 残缺快照绝不能拿去合并：没取到的条目会被当成「取消收藏」删掉
    throw new Error(
      `这次只取到部分收藏夹（${partialNote}），不能拿来合并 —— ` +
      '没取到的会被当成「取消收藏」从世界里删掉。把 --max 调大（或去掉）再试。',
    );
  }

  if (doMerge && existsSync(out)) {
    const existing = parseWorld(readFileSync(out, 'utf8'));
    const oldItems = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : [];
    result = await mergeWorld(existing, oldItems, items, {});
    stats = {
      kept: result.kept,
      added: result.added.length,
      dropped: result.dropped,
      newRegions: result.newRegions.length,
      fromVersion: existing.layoutVersion,
    };
    title = existing.name;
    source = existing.source;
  } else {
    result = await buildWorldFromItems(items, {
      title,
      source,
      seedKey: `${fid ?? source}|${title}`,
      note: partialNote,
    });
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.world, 'utf8');
  writeFileSync(cachePath, JSON.stringify(items, null, 0), 'utf8');

  console.log(`  worldc · 导入${stats ? '（合并）' : ''}`);
  console.log('  ' + RULE);
  console.log(`  ${pad('folder', 8)}${title}${fid ? `（${fid}）` : ''}`);
  console.log(
    `  ${pad('items', 8)}${items.length}` +
    (stats ? `  ·  原地 ${stats.kept} / 新增 ${stats.added} / 移除 ${stats.dropped}` : ''),
  );
  console.log(`  ${pad('seed', 8)}0x${result.seed.toString(16)}`);
  console.log(
    `  ${pad('layout', 8)}2` +
    (stats && stats.fromVersion === 1 ? '  （旧源码是 v1，已按原格位迁移到 v2）' : ''),
  );
  console.log(
    `  ${pad('regions', 8)}${result.regions.length}` +
    (stats && stats.newRegions ? `  （新开 ${stats.newRegions} 个）` : ''),
  );
  for (const r of result.regions) {
    console.log(`  ${' '.repeat(8)}▸ ${pad(r.name, 14)}${pad(`${r.entries.length} 件`, 10)}${r.rows}×${r.cols}`);
  }
  if (partial) console.log(`  ${pad('partial', 8)}${partialNote}`);
  console.log(`  ${pad('source', 8)}${out}  ·  ${result.world.split('\n').length} 行  ·  ${(Buffer.byteLength(result.world) / 1024).toFixed(1)} KB`);
  console.log(`  ${pad('cache', 8)}${cachePath}`);
  console.log('');
  console.log(`  下一步：node src/cli.mjs build ${out} --out build/scene.json`);
  if (stats) console.log(`  想看动了谁：node src/cli.mjs diff <旧.world> ${out}`);
  console.log('');
}

const cmd = process.argv[2];try {
  if (cmd === 'build') cmdBuild();
  else if (cmd === 'diff') cmdDiff();
  else if (cmd === 'plan') cmdPlan();
  else if (cmd === 'import') await cmdImport();
  else {
    console.log('worldc · 世界编译器 v0.1');
    console.log('  import <收藏夹链接 | "mid fid"> [--max N] [--out x.world] [--merge]');
    console.log('  build  <file.world> [--items-from x.items.json] [--out scene.json]');
    console.log('  plan   <file.world> [--out build/plan.svg]');
    console.log('  diff   <a.world> <b.world>');
  }
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exit(1);
}
