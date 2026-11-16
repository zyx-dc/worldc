// 2D 后端：同一份 IR → 一张展陈平面图（时间从走廊入口向右流）。
// 它证明 IR 不是 three.js 的包装：换一个后端，数据一行都不用改。

import { placeRegions } from '../world-layout.mjs';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {object} ir
 * @returns {string} SVG
 */
export function renderPlan(ir) {
  const layout = placeRegions(ir);
  const { regions, totalDepth, maxWidth } = layout;

  const W = 880;
  const padX = 42;
  const padTop = 64;
  const axisH = 34;
  const padBottom = 26;

  const s = (W - padX * 2) / totalDepth;
  const H = Math.round(padTop + maxWidth * s + axisH + padBottom);

  const px = dist => padX + dist * s;
  const py = worldX => padTop + (worldX + maxWidth / 2) * s;
  const axisY = padTop + maxWidth * s + 16;
  const nodeCount = ir.regions.reduce((n, r) => n + r.exhibits.length, 0);

  const p = [];

  p.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'PingFang SC','Microsoft YaHei',system-ui,sans-serif">`,
    `<title>${esc(ir.world)} · 展陈平面图</title>`,
    `<desc>由同一份场景图（IR）生成的 2D 导览图，与 3D 漫游后端共用数据与布局代码。</desc>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${padX}" y="24" font-size="14" font-weight="500" fill="#2C2C2A">${esc(ir.world)}</text>`,
    `<text x="${padX}" y="41" font-size="11" fill="#888780">sha256 ${esc(ir.__hash || '')}　seed 0x${Number(ir.seed).toString(16)}　${nodeCount} 件展品　${regions.length} 个展区</text>`,
  );

  for (const r of regions) {
    const x0 = px(-r.zNear);
    const x1 = px(-r.zNear + r.d);
    const y0 = py(-r.w / 2);
    const y1 = py(r.w / 2);

    p.push(
      `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" rx="4" fill="hsl(${r.hue} 45% 96%)" stroke="hsl(${r.hue} 50% 74%)" stroke-width="0.5"/>`,
      `<text x="${x0.toFixed(1)}" y="${(y0 - 8).toFixed(1)}" font-size="12" font-weight="500" fill="hsl(${r.hue} 55% 30%)">${esc(r.name)}</text>`,
      `<text x="${x1.toFixed(1)}" y="${(y0 - 8).toFixed(1)}" font-size="11" fill="#888780" text-anchor="end">${r.exhibits.length} 件</text>`,
    );

    for (const e of r.exhibits) {
      const cx = px(-r.zNear + r.d / 2 - e.pos[2]);
      const cy = py(e.wx);
      const rad = e.pinned ? 3.4 : 2.1;
      p.push(e.pinned
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad}" fill="hsl(${r.hue} 72% 40%)" stroke="#4A1B0C" stroke-width="1"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad}" fill="hsl(${r.hue} 62% 58%)"/>`);
    }

    p.push(
      `<line x1="${x0.toFixed(1)}" y1="${axisY}" x2="${x1.toFixed(1)}" y2="${axisY}" stroke="#D3D1C7" stroke-width="0.5"/>`,
      `<line x1="${x0.toFixed(1)}" y1="${axisY - 3}" x2="${x0.toFixed(1)}" y2="${axisY + 3}" stroke="#B4B2A9" stroke-width="0.5"/>`,
      `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${axisY + 17}" font-size="11" fill="#888780" text-anchor="middle">${r.years[0] === r.years[1] ? r.years[0] : `${r.years[0]}–${r.years[1]}`}</text>`,
    );
  }

  const enterX = px(0);
  p.push(
    `<path d="M${enterX.toFixed(1)} ${axisY - 5} l-5 9 l10 0 z" fill="#993C1D"/>`,
    `<text x="${enterX.toFixed(1)}" y="${axisY + 17}" font-size="11" fill="#993C1D" text-anchor="middle">入口</text>`,
    `<text x="${padX}" y="${H - 6}" font-size="11" fill="#B4B2A9">同一份 IR · 2D 后端　—　走到尽头 ${layout.regions.length} 个展区，${Math.round(totalDepth)} 个世界单位</text>`,
  );

  p.push('</svg>');
  return p.join('\n');
}
