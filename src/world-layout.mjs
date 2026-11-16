// 世界布局：把 IR 里各自中心在原点的 region，沿 -Z 方向排成一条时间走廊。
// 这个文件被 3D 后端（viewer/main.js）和 2D 后端（src/render/plan.mjs）共用 ——
// 同一份 IR，两个后端，不是两套数据。

export const GAP = 9;

/**
 * @param {object} ir 编译产物
 * @returns {{regions:Array, totalDepth:number, maxWidth:number, gap:number}}
 */
export function placeRegions(ir) {
  const regions = [];
  let cursor = 0;

  for (const r of ir.regions) {
    const w = r.bounds.w;
    const d = r.bounds.d;
    const zNear = cursor;
    const zFar = cursor - d;

    regions.push({
      name: r.name,
      hue: r.hue,
      span: r.span,
      years: r.years || r.span,
      w,
      d,
      zNear,
      zFar,
      centerZ: cursor - d / 2,
      exhibits: r.exhibits.map(e => ({
        ...e,
        wx: e.pos[0],
        wy: e.pos[1],
        wz: cursor - d / 2 + e.pos[2],
      })),
    });

    cursor = zFar - GAP;
  }

  const totalDepth = regions.reduce((s, r) => s + r.d, 0) + GAP * Math.max(0, regions.length - 1);
  const maxWidth = Math.max(...regions.map(r => r.w), 1);

  return { regions, totalDepth, maxWidth, gap: GAP };
}

/** 相机起点：走廊入口，面朝 -Z */
export function cameraStart(layout) {
  return { x: 0, y: 1.65, z: layout.regions[0].zNear + 6 };
}

/** 当前所在的 region（用于 HUD 显示） */
export function regionAt(layout, z) {
  for (const r of layout.regions) {
    if (z <= r.zNear + 1 && z >= r.zFar - 1) return r;
  }
  return null;
}
