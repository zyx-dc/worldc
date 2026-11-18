// 布局推导层：纯函数。
// 输入 (region, 成员, seed) → 展位坐标。同样的输入永远得到同样的输出，
// 这是整个架构能「可复现 + 可 diff」的地基。
//
// 两套算法并存，由 .world 顶部的 `layout N` 选择：
//
//   v1  格子 = 成员在区域内的序号。写得短，但收藏夹中间插一条，
//       它后面的每一件都平移一格 —— 收藏夹一更新，整片重排。
//
//   v2  格子 = 源码里 place 行写死的。导入时分配一次，之后就写进 .world，
//       新收藏只找空格子，旧展品一格都不动。
//       身份与位置的绑定是**数据**，而不是每次编译重新算出来的。
//
// v1 冻结：以后改算法不会改旧文件的编译结果。

import { rngFrom, round } from './rng.mjs';

const SPACING = 3.4;

/** 素材身份：A-03 之后是 key（bv_xxx / mock_7），更早的数据可能只有数字 id */
export function keyOf(item) {
  return String(item.key ?? item.id);
}

/**
 * 每件展品一条独立的确定性随机流。
 * 必须用身份而不是序号 —— 否则加一件会让整区的抖动全部重排。
 */
function jitter(seed, regionName, key) {
  const rnd = rngFrom(String(seed), regionName, key);
  return {
    jx: (rnd() - 0.5) * 0.4,
    jz: (rnd() - 0.5) * 0.4,
    rot: (rnd() - 0.5) * 8,
  };
}

/**
 * 在 rows×cols 的格网里找第一个空格子（行优先）。
 *
 * 只看「已占用集合」，不看这个格网是一步步长出来的还是新建的：
 * 分两次导入（先 10 条、再加 3 条）与一次导入 13 条，落位完全一致 ——
 * 后加的永远接着往后排，不会插到前面去。
 */
export function firstFreeCell(rows, cols, occupied) {
  const cap = rows * cols;
  for (let cell = 0; cell < cap; cell++) {
    if (!occupied.has(cell)) return cell;
  }
  return null;
}

function makeExhibit(item, seed, regionName, rows, cols, cell) {
  const r = Math.floor(cell / cols);
  const c = cell % cols;
  const key = keyOf(item);
  const { jx, jz, rot } = jitter(seed, regionName, key);

  return {
    item: key,
    title: item.title,
    year: item.year,
    cover: item.cover,
    owner: item.owner,
    pos: [
      round((c - (cols - 1) / 2) * SPACING + jx),
      0,
      round((r - (rows - 1) / 2) * SPACING + jz),
    ],
    rot: round(rot, 2),
    pinned: false,
  };
}

/** v1：序号落格。冻结，不再改动。 */
export function layoutRegion(region, items, seed) {
  const { rows, cols } = region.layout;
  return items
    .slice(0, rows * cols)
    .map((item, i) => makeExhibit(item, seed, region.name, rows, cols, i));
}

/**
 * v2：格子来自 place 行；没写 place 的才做确定性分配。
 * @param {Array} entries [{ key, item, row, col }]，row/col 为 null 表示源码里没写 place
 */
export function layoutRegionV2(region, entries, seed) {
  const { rows, cols } = region.layout;

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.key)) throw new Error(`区域「${region.name}」："${e.key}" 出现了不止一次`);
    seen.add(e.key);
  }

  const cellByKey = new Map();
  const taken = new Map();   // cell → key

  for (const e of entries) {
    if (e.row == null) continue;

    if (!(e.row >= 0 && e.row < rows && e.col >= 0 && e.col < cols)) {
      throw new Error(
        `区域「${region.name}」：place "${e.key}" 的格子 (${e.row}, ${e.col}) 超出 grid ${rows}×${cols}`,
      );
    }

    const cell = e.row * cols + e.col;
    if (taken.has(cell)) {
      throw new Error(
        `区域「${region.name}」：${taken.get(cell)} 与 ${e.key} 都落在格子 (${e.row}, ${e.col})`,
      );
    }
    cellByKey.set(e.key, cell);
    taken.set(cell, e.key);
  }

  const occupied = new Set(taken.keys());
  for (const e of entries) {
    if (e.row != null) continue;
    const cell = firstFreeCell(rows, cols, occupied);
    if (cell == null) {
      throw new Error(
        `区域「${region.name}」放不下 "${e.key}"：grid ${rows}×${cols} 已满。` +
        `请调大 grid，或为它新开一个区域。`,
      );
    }
    occupied.add(cell);
    cellByKey.set(e.key, cell);
  }

  return entries.map(e => makeExhibit(e.item, seed, region.name, rows, cols, cellByKey.get(e.key)));
}

/** region 自身的体量（用于渲染时画地板和墙） */
export function regionBounds(region) {
  const { rows, cols } = region.layout;
  return {
    w: round((cols - 1) * SPACING + 4),
    d: round((rows - 1) * SPACING + 4),
    h: 4.2,
  };
}
