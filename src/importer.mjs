// 把一批 items 变成一份人可读、可手改的 .world 源文件。
// 注意：生成的是**源码**，不是场景。之后所有改动都发生在源码上。
//
// 布局 v2 起，位置不再是「编译时按下标算出来的」，而是导入时分配一次、
// 写进源码的 place 行。收藏夹更新时：
//
//   旧的 place 原样保留  →  旧展品一格不动
//   新条目只占空格       →  空间 diff 只报 added，不报 moved
//
// 这就是「版本更新算法」的两半：算法版本写在 layout 2 里，
// 数据版本靠 place 行增量追加。

import { hash32 } from './rng.mjs';
import { nameRegions } from './naming.mjs';
import { keyOf, firstFreeCell } from './layout.mjs';
import { quoteString as esc } from './parse.mjs';

const HUES = [210, 28, 285, 160, 340, 100];
const COLS = 6;
const SPARE_ROWS = 2;      // 每区预留两排空格：收藏夹涨几条不用动区域结构

const ym = ts => (ts ? new Date(ts).toISOString().slice(0, 7) : '?');

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 把「区域 + 每件一个格子」渲染成源码 */
function renderWorld({ title, source, seed, regions, totalItems }) {
  const head = [
    '# 由 worldc import 生成 —— 这是一份源码，不是场景。',
    '# 想改世界就改这个文件，然后重新 build。改一行不会动到别的展品。',
    '#',
    '# place 行是「身份 → 格子」的永久记录：收藏夹更新时不要删它们，',
    '# 重新用 import --merge 追加，旧展品就会留在原地。',
    `# 源：${title}（${source}）`,
    `# ${totalItems} 件`,
    '',
    `world ${esc(title)} {`,
    `  seed 0x${seed.toString(16)}`,
    `  source ${esc(source)}`,
    `  items ${totalItems}`,
    '  layout 2',
    '',
  ];

  const body = [];
  for (const r of regions) {
    if (!r.entries.length) continue;
    const span = r.years ? `${r.years[0]} ~ ${r.years[1]}` : '—';
    body.push(
      `  # ${r.name} · ${span} · ${r.entries.length} 件`,
      `  region ${esc(r.name)} {`,
      `    hue ${r.hue}`,
      `    layout grid ${r.rows} ${r.cols}`,
    );
    for (const e of r.entries) {
      body.push(`    place ${esc(e.key)} ${Math.floor(e.cell / r.cols)} ${e.cell % r.cols}`);
    }
    body.push('  }', '');
  }

  return [...head, ...body, '}'].join('\n');
}

/**
 * 首次导入：把 items 分块成区域，逐件分配格子。
 * @returns {Promise<{world:string, regions:Array, seed:number}>}
 */
export async function buildWorldFromItems(items, opt) {
  const { title, source, seedKey, perRegion = 36, strategy = 'keyword' } = opt;
  if (!items.length) throw new Error('收藏夹是空的，没什么可编译的');

  // 分块：每块大约一屏能走完
  const want = Math.max(1, Math.min(6, Math.ceil(items.length / perRegion)));
  const size = Math.ceil(items.length / want);
  const groups = chunk(items, size);

  const names = await nameRegions(
    groups.map(g => ({ titles: g.map(i => i.title), hint: `${ym(g[0].ts)} ~ ${ym(g[g.length - 1].ts)}` })),
    strategy,
  );

  const regions = groups.map((g, i) => {
    const years = g.map(x => x.year).filter(Boolean);
    return {
      name: names[i] || `第 ${i + 1} 区`,
      hue: HUES[i % HUES.length],
      rows: Math.ceil(g.length / COLS) + SPARE_ROWS,
      cols: COLS,
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      entries: g.map((it, k) => ({ key: keyOf(it), cell: k })),
    };
  });

  // seed 只取决于世界身份与「种子派生版本」，不能掺 items.length。
  // 掺进去的后果：收藏夹多一条，seed 就变，整片布局重排 ——
  // 与「同一份收藏夹永远同一片星海」直接冲突。
  const seed = hash32(`${seedKey}|world-v1`);

  return { world: renderWorld({ title, source, seed, regions, totalItems: items.length }), regions, seed };
}

/**
 * 增量导入：读旧源码（v1 或 v2 都行），保留每一个已有格位，只给新条目排位。
 *
 * v1 源码没有格位信息，但它的格子是「序号 → 行列」算出来的，
 * 用旧快照 items.json 就能一比一还原 —— 所以这一步也顺带完成了 v1 → v2 迁移。
 *
 * @param {object} existing  parse 出来的旧 .world
 * @param {Array}  oldItems  旧快照（用来还原 v1 的 take 区间与年份）
 * @param {Array}  newItems  新快照
 */
export async function mergeWorld(existing, oldItems, newItems, opt = {}) {
  const { strategy = 'keyword', perRegion = 36 } = opt;

  // v1 源码里没有格位，只能靠旧快照按 take 区间还原。
  // 快照不在就硬合并，等于把所有人重新排一遍 —— 宁可报错。
  if (!oldItems.length && existing.regions.some(r => !(r.places || []).length)) {
    throw new Error(
      '旧源码是 v1，但它旁边的 items.json 快照不见了 —— 没有快照就还原不出旧格位，' +
      '硬合并会把整片重排。请找回原快照再跑，或换个 --out 重新导入。',
    );
  }

  const oldByKey = new Map(oldItems.map(it => [keyOf(it), it]));

  // 1) 旧世界 → 统一模型 { name, hue, rows, cols, years, entries:[{key, cell}] }
  const regions = existing.regions.map(r => {
    const { rows, cols } = r.layout;
    let entries;

    if ((r.places || []).length) {
      entries = r.places.map(p => ({ key: p.item, cell: p.row * cols + p.col }));
    } else {
      // v1：成员来自 take/span，格子就是序号
      const slice = r.take
        ? oldItems.slice(r.take[0], r.take[1] + 1)
        : oldItems.filter(it => it.year >= r.span[0] && it.year <= r.span[1]);
      entries = slice
        .map((it, i) => ({ key: keyOf(it), cell: i }))
        .filter(e => e.cell < rows * cols);
    }

    const years = entries.map(e => oldByKey.get(e.key)?.year).filter(Boolean);

    return {
      name: r.name,
      hue: r.hue,
      rows,
      cols,
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      entries,
    };
  });

  // 收藏夹里被取消收藏的：从源码里一并移除，但必须报出来，不静默改世界
  const newKeySet = new Set(newItems.map(keyOf));
  let dropped = 0;
  for (const r of regions) {
    const keep = r.entries.filter(e => newKeySet.has(e.key));
    dropped += r.entries.length - keep.length;
    r.entries = keep;
  }

  // 空区必须整个去掉：源码里的空 region 会被当成「按年份收全部」，反而吞掉别的东西
  const live = regions.filter(r => r.entries.length);
  regions.length = 0;
  regions.push(...live);

  const known = new Set(regions.flatMap(r => r.entries.map(e => e.key)));
  const fresh = newItems.filter(it => !known.has(keyOf(it)));

  // 2) 新条目：从最新的区往前找空格；都满了再开新区
  const added = [];
  const leftover = [];

  for (const it of fresh) {
    const key = keyOf(it);
    let done = false;
    for (let i = regions.length - 1; i >= 0 && !done; i--) {
      const r = regions[i];
      const occupied = new Set(r.entries.map(e => e.cell));
      const cell = firstFreeCell(r.rows, r.cols, occupied);
      if (cell == null) continue;
      r.entries.push({ key, cell });
      added.push({ key, region: r.name, cell });
      done = true;
    }
    if (!done) leftover.push(it);
  }

  // 3) 还放不下的，按 perRegion 开新区
  const newRegions = [];
  if (leftover.length) {
    const groups = chunk(leftover, perRegion);
    const names = await nameRegions(
      groups.map(g => ({ titles: g.map(i => i.title), hint: `${ym(g[0].ts)} ~ ${ym(g[g.length - 1].ts)}` })),
      strategy,
    );
    groups.forEach((g, i) => {
      const years = g.map(x => x.year).filter(Boolean);
      const reg = {
        name: names[i] || `新增 ${i + 1}`,
        hue: HUES[(regions.length + i) % HUES.length],
        rows: Math.ceil(g.length / COLS) + SPARE_ROWS,
        cols: COLS,
        years: years.length ? [Math.min(...years), Math.max(...years)] : null,
        entries: g.map((it, k) => ({ key: keyOf(it), cell: k })),
      };
      regions.push(reg);
      newRegions.push(reg);
      for (const e of reg.entries) added.push({ key: e.key, region: reg.name, cell: e.cell });
    });
  }

  const world = renderWorld({
    title: existing.name,
    source: existing.source,
    seed: existing.seed,
    regions,
    totalItems: newItems.length,
  });

  return { world, regions, seed: existing.seed, added, newRegions, kept: known.size, dropped };
}
