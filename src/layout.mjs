// 布局推导层：纯函数。
// 输入 (region, items, seed) → 展位坐标。同样的输入永远得到同样的输出，
// 这是整个架构能"可复现 + 可 diff"的地基。

import { rngFrom, round } from './rng.mjs';

const SPACING = 3.4;

/** 把一个 region 的展品推导到网格上 */
export function layoutRegion(region, items, seed) {
  const { rows, cols } = region.layout;
  const list = items.slice(0, rows * cols);
  const spacing = SPACING;

  return list.map((item, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;

    // 每件展品一个独立的确定性随机流：加一件不会挪动别人
    const rnd = rngFrom(String(seed), region.name, String(item.id));

    const jx = (rnd() - 0.5) * 0.4;
    const jz = (rnd() - 0.5) * 0.4;
    const rot = (rnd() - 0.5) * 8;

    return {
      item: item.id,
      title: item.title,
      year: item.year,
      cover: item.cover,
      owner: item.owner,
      pos: [
        round((c - (cols - 1) / 2) * spacing + jx),
        0,
        round((r - (rows - 1) / 2) * spacing + jz),
      ],
      rot: round(rot, 2),
      pinned: false,
    };
  });
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
