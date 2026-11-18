// 把一批 items 变成一份人可读、可手改的 .world 源文件。
// 注意：生成的是**源码**，不是场景。之后所有改动都发生在源码上。

import { hash32 } from './rng.mjs';
import { nameRegions } from './naming.mjs';

const HUES = [210, 28, 285, 160, 340, 100];
const COLS = 6;

const esc = s => String(s).replace(/"/g, '\\"');
const ym = ts => (ts ? new Date(ts).toISOString().slice(0, 7) : '?');

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * @param {Array} items  已按时间排序的 items
 * @param {{title:string, source:string, seedKey:string, perRegion?:number, strategy?:string}} opt
 * @returns {Promise<{world:string, regions:Array, seed:number}>}
 */
export async function buildWorldFromItems(items, opt) {
  const { title, source, seedKey, perRegion = 36, strategy = 'keyword' } = opt;

  const groups = [];
  if (!items.length) throw new Error('收藏夹是空的，没什么可编译的');

  // 分块：每块大约一屏能走完
  const want = Math.max(1, Math.min(6, Math.ceil(items.length / perRegion)));
  const size = Math.ceil(items.length / want);
  const chunks = chunk(items, size);

  let cursor = 0;
  for (const c of chunks) {
    groups.push({
      items: c,
      titles: c.map(i => i.title),
      from: cursor,
      to: cursor + c.length - 1,
      hint: `${ym(c[0].ts)} ~ ${ym(c[c.length - 1].ts)}`,
    });
    cursor += c.length;
  }

  const names = await nameRegions(groups.map(g => ({ titles: g.titles, hint: g.hint })), strategy);

  const regions = groups.map((g, i) => {
    const rows = Math.ceil(g.items.length / COLS);
    const yearFrom = Math.min(...g.items.map(x => x.year).filter(Boolean));
    const yearTo = Math.max(...g.items.map(x => x.year).filter(Boolean));
    return {
      name: names[i] || (Number.isFinite(yearFrom) ? `${yearFrom} 年` : `第 ${i + 1} 区`),
      take: [g.from, g.to],
      hue: HUES[i % HUES.length],
      rows,
      cols: COLS,
      count: g.items.length,
      years: [yearFrom, yearTo],
      span: g.hint,
    };
  });

  // seed 只取决于世界身份与算法版本，**不能**掺 items.length。
  // 掺进去的后果：收藏夹多一条，seed 就变，整片布局重排 ——
  // 与「同一份收藏夹永远同一片星海」直接冲突。
  const seed = hash32(`${seedKey}|world-v1`);
  const head = [
    '# 由 worldc import 生成 —— 这是一份源码，不是场景。',
    '# 想改世界就改这个文件，然后重新 build。改一行不会动到别的展品。',
    `# 源：${title}（${source}）`,
    `# ${items.length} 件 · ${ym(items[0].ts)} ~ ${ym(items[items.length - 1].ts)}`,
    '',
    `world "${esc(title)}" {`,
    `  seed 0x${seed.toString(16)}`,
    `  source "${esc(source)}"`,
    `  items ${items.length}`,
    '',
  ];

  const body = [];
  for (const r of regions) {
    body.push(
      `  # ${r.name} · ${r.span} · ${r.count} 件`,
      `  region "${esc(r.name)}" {`,
      `    take ${r.take[0]}..${r.take[1]}`,
      `    hue ${r.hue}`,
      `    layout grid ${r.rows} ${r.cols}`,
      '  }',
      '',
    );
  }

  return { world: [...head, ...body, '}'].join('\n'), regions, seed };
}
