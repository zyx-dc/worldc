// 编译器：.world + items → IR（场景图）
// 规则：
//   1. 纯函数，不读时间、不读随机数、不读文件
//   2. 输出可 canonical 序列化，内容寻址（hash）
//   3. 覆盖层（pin）在推导之后应用，不影响其它展品

import { sha256Hex, byteLength } from './hash.mjs';
import { layoutRegion, layoutRegionV2, regionBounds, keyOf } from './layout.mjs';
import { hash32 } from './rng.mjs';

/** 键序稳定的序列化：保证同样的对象永远产出同样的字符串 */
export function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return sha256Hex(canonical(value));
}

/**
 * 编译一个世界
 * @param {object} world  parse 出来的 .world
 * @param {Array}  items  [{id,title,cover,year,owner}]
 * @returns {{ir:object, hash:string, stats:object}}
 */
export function compile(world, items) {
  const regions = [];
  const placed = new Set();
  let overflow = 0;

  const algo = Number(world.layoutVersion ?? 1);
  const byKey = new Map(items.map(it => [keyOf(it), it]));

  for (const region of world.regions) {
    let members;
    let exhibits;

    if (algo >= 2 && (region.places || []).length) {
      // ── v2：成员与格位都由 place 行决定 ──────────────────
      // 这就是「收藏夹更新、旧展品不动」的全部原因：谁在这个区、
      // 站在第几格，都写在源码里，不依赖数组下标。
      const entries = region.places.map(p => {
        const it = byKey.get(p.item);
        if (!it) {
          throw new Error(
            `区域「${region.name}」的 place 引用了不存在的展品 "${p.item}" —— ` +
            `收藏夹里已经没有它了。删掉这一行，或把 items.json 换回旧快照。`,
          );
        }
        return { key: p.item, item: it, row: p.row, col: p.col, fresh: !!p.fresh };
      });
      members = entries.map(e => e.item);
      exhibits = layoutRegionV2(region, entries, world.seed);
    } else {
      // ── v1（以及没写 place 的 v2 区域）：按序号 / 年份选区 ──
      // 两种选区方式：按年份区间（span），或按序号区间（take）。
      // take 给 import 用：精确、不重叠，天然按时间排序。
      const inSpan = region.take
        ? items.slice(region.take[0], region.take[1] + 1)
        : items.filter(it => it.year >= region.span[0] && it.year <= region.span[1]);

      const cap = region.layout.rows * region.layout.cols;
      if (inSpan.length > cap) overflow += inSpan.length - cap;

      members = inSpan;
      exhibits = layoutRegion(region, inSpan, world.seed);
    }

    for (const ex of exhibits) placed.add(ex.item);

    const yrs = members.map(it => it.year).filter(Boolean);
    const years = yrs.length ? [Math.min(...yrs), Math.max(...yrs)] : region.span;

    regions.push({
      name: region.name,
      hue: region.hue,
      span: region.span,
      years,
      layout: region.layout,
      bounds: regionBounds(region),
      exhibits,
    });
  }

  // 覆盖层：手挪过的展品，只覆盖坐标，不重新布局
  const pinnedIds = new Set();
  for (const pin of world.pins) {
    let hit = false;
    for (const region of regions) {
      const ex = region.exhibits.find(e => e.item === pin.item);
      if (!ex) continue;
      hit = true;
      ex.pos = pin.pos;
      ex.rot = pin.rot;
      ex.pinned = true;
      pinnedIds.add(pin.item);
    }
    // 以前这里是 continue：pin 写错一个字符就被静默丢掉，
    // 编辑器里拖动「没反应」，而且一点线索都没有。
    if (!hit) {
      throw new Error(
        `pin 引用了不存在的展品 "${pin.item}" —— ` +
        `跑 node src/cli.mjs check 看看它能匹配到哪个。`,
      );
    }
  }

  const ir = {
    irVersion: algo >= 2 ? 2 : 1,
    world: world.name,
    seed: world.seed,
    source: world.source,
    regions,
  };
  // 只在 v2 里带这个字段：v1 世界的 hash 必须一字不变
  if (algo >= 2) ir.layoutVersion = algo;

  const stats = {
    layout: algo,
    items: items.length,
    placed: placed.size,
    // 收藏夹里有、但源码还没给它 place 的件数。合并导入之后应该为 0。
    unplaced: items.length - placed.size,
    overflow,
    regions: regions.length,
    pinned: pinnedIds.size,
    bytes: byteLength(canonical(ir)),
  };

  return { ir, hash: digest(ir), stats };
}

/** 两个 IR 之间的空间 diff：谁挪了、谁消失了 */
export function diff(irA, irB) {
  const index = ir => {
    const m = new Map();
    for (const r of ir.regions) for (const e of r.exhibits) m.set(e.item, { ...e, region: r.name });
    return m;
  };
  const A = index(irA);
  const B = index(irB);

  const POS_EPS = 1e-3;    // 米
  const ROT_EPS = 0.05;    // 度

  const normDeg = a => { const x = (a ?? 0) % 360; return x < 0 ? x + 360 : x; };
  const angDiff = (a, b) => {
    const d = Math.abs(normDeg(a) - normDeg(b));
    return Math.min(d, 360 - d);
  };

  const moved = [];
  const rotated = [];
  const regionChanged = [];
  const gone = [];
  const added = [];

  for (const [id, a] of A) {
    const b = B.get(id);
    if (!b) { gone.push(a); continue; }

    const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
    if (d > POS_EPS) moved.push({ id, from: a.pos, to: b.pos, distance: Number(d.toFixed(3)), region: b.region });

    // 只转不移也要报出来，否则「转了一下」在 diff 里等于没发生
    const ad = angDiff(a.rot, b.rot);
    if (ad > ROT_EPS) rotated.push({ id, from: a.rot ?? 0, to: b.rot ?? 0, delta: Number(ad.toFixed(2)) });

    if (a.region !== b.region) regionChanged.push({ id, from: a.region, to: b.region });
  }
  for (const [id, b] of B) if (!A.has(id)) added.push(b);

  return { moved, rotated, regionChanged, gone, added };
}

export { hash32 };
