// 编译前的校验层：把所有「能编译过去但结果不对」的情况一次性说出来。
//
// 为什么单独一层，而不是塞进 parse / compile：
//   - parse 只管语法。语法对、语义错是最难查的一类。
//   - compile 是纯函数，报错要尽量少而准（它每帧都会被浏览器调用）。
//   - 校验需要「源码 + 素材」两边的信息，只有调用方同时有。
//
// 分两级：
//   error    世界是错的，别编译（引用不存在、格子冲突、未知算法版本……）
//   warning  能编译，但结果可能不是你想要的（容量溢出、件数对不上……）
//
// 每条都带一个稳定的 code，方便测试断言，也方便以后做编辑器里的行内提示。

import { keyOf } from './layout.mjs';

const MAX_SEED = 0xffffffff;
const KNOWN_LAYOUT = new Set([1, 2]);

/** 编辑距离，用来给拼错的 key 一个「是想写 X 吗」 */
function distance(a, b, cutoff = Infinity) {
  if (Math.abs(a.length - b.length) >= cutoff) return cutoff;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin >= cutoff) return cutoff;
    prev = cur;
  }
  return prev[b.length];
}

function hint(bad, candidates) {
  const limit = Math.max(2, Math.floor(bad.length * 0.3));
  let best = null;
  let bestD = limit + 1;
  for (const k of candidates) {
    const d = distance(bad, k, bestD);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best ? `（是想写 "${best}" 吗？）` : '';
}

/**
 * @param {object} world parse 出来的源码
 * @param {Array}  items 素材
 * @returns {{ok:boolean, errors:Array<{code,msg}>, warnings:Array<{code,msg}>}}
 */
export function validate(world, items = []) {
  const errors = [];
  const warnings = [];
  const err = (code, msg) => errors.push({ code, msg });
  const warn = (code, msg) => warnings.push({ code, msg });

  // ── 世界级 ─────────────────────────────────────────────
  if (!Number.isInteger(world.seed)) {
    err('E-SEED', `seed 必须是整数，现在是 ${world.seed}`);
  } else if (world.seed < 0 || world.seed > MAX_SEED) {
    err('E-SEED', `seed ${world.seed} 超出 32 位范围（0..${MAX_SEED}）`);
  }

  // 未知版本不能当成 v1 悄悄跑 —— 那样「换算法」会变成静默改世界
  if (!KNOWN_LAYOUT.has(world.layoutVersion)) {
    err('E-LAYOUT', `未知的 layout 版本 ${world.layoutVersion}：只认得 1 和 2`);
  }

  const keys = new Set(items.map(keyOf));

  // ── 展区 ───────────────────────────────────────────────
  const seenName = new Set();
  const owner = new Map();     // 展品 key → 所在展区

  for (const r of world.regions) {
    const places = r.places || [];
    const tag = `展区「${r.name}」`;

    if (seenName.has(r.name)) err('E-REGION-DUP', `有两个展区都叫「${r.name}」，没法区分`);
    seenName.add(r.name);

    const { rows, cols } = r.layout;
    if (!(rows >= 1 && cols >= 1)) {
      err('E-GRID', `${tag}的 grid 是 ${rows}×${cols}，行列都得 ≥ 1`);
      continue;   // 后面的容量计算没意义
    }
    const cap = rows * cols;

    if (r.take) {
      const [a, b] = r.take;
      if (a > b) err('E-TAKE', `${tag}的 take ${a}..${b}：起点比终点大`);
      else if (items.length && b >= items.length) {
        warn('W-TAKE', `${tag}的 take 到第 ${b} 件，但一共只有 ${items.length} 件`);
      }
    }
    if (r.span[0] > r.span[1]) {
      err('E-SPAN', `${tag}的 span ${r.span[0]}..${r.span[1]}：起点比终点大`);
    }

    // 成员：有 place 就以 place 为准，否则按 take / span 选
    const members = places.length
      ? places.map(p => p.item)
      : (r.take
          ? items.slice(r.take[0], r.take[1] + 1)
          : items.filter(it => it.year >= r.span[0] && it.year <= r.span[1])
        ).map(keyOf);

    if (!members.length) warn('W-EMPTY', `${tag}一件展品也没有`);
    if (members.length > cap) {
      warn('W-CAP', `${tag}有 ${members.length} 件，但只有 ${cap} 格，会溢出 ${members.length - cap} 件`);
    }

    // place 自身
    const keySeen = new Set();
    const cellSeen = new Map();
    for (const p of places) {
      if (keySeen.has(p.item)) {
        err('E-PLACE-DUP', `${tag}里 "${p.item}" 写了不止一条 place`);
      }
      keySeen.add(p.item);

      if (!keys.has(p.item)) {
        err('E-PLACE-MISSING', `${tag}的 place 引用了不存在的展品 "${p.item}"${hint(p.item, keys)}`);
      }
      if (!(p.row >= 0 && p.row < rows && p.col >= 0 && p.col < cols)) {
        err('E-PLACE-RANGE', `${tag}：place "${p.item}" 的格子 (${p.row}, ${p.col}) 超出 grid ${rows}×${cols}`);
        continue;
      }
      const cell = p.row * cols + p.col;
      if (cellSeen.has(cell)) {
        err('E-PLACE-COLLIDE', `${tag}：${cellSeen.get(cell)} 与 ${p.item} 都落在格子 (${p.row}, ${p.col})`);
      }
      cellSeen.set(cell, p.item);
    }

    // 一件展品只能属于一个展区
    for (const k of members) {
      if (owner.has(k)) {
        err('E-ITEM-DUP', `"${k}" 同时出现在「${owner.get(k)}」和「${r.name}」`);
      } else {
        owner.set(k, r.name);
      }
    }
  }

  // ── pin ───────────────────────────────────────────────
  for (const pin of world.pins) {
    // 这一条以前是静默丢弃的：写错一个字符，拖拽就「没反应」，很难查
    if (!owner.has(pin.item) && !keys.has(pin.item)) {
      err('E-PIN-MISSING', `pin 引用了不存在的展品 "${pin.item}"${hint(pin.item, keys)}`);
    }
    if (!pin.pos.every(Number.isFinite)) {
      err('E-PIN-POS', `pin "${pin.item}" 的坐标不是有限数：${JSON.stringify(pin.pos)}`);
    }
    if (!Number.isFinite(pin.rot)) {
      err('E-PIN-ROT', `pin "${pin.item}" 的 rot 不是有限数：${pin.rot}`);
    }
  }

  // ── 元信息 ─────────────────────────────────────────────
  if (items.length && world.items != null && world.items !== items.length) {
    warn('W-COUNT', `源码写着 ${world.items} 件，实际喂进来 ${items.length} 件`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 把校验结果打到终端，返回是否通过 */
export function report(result, log = console.log) {
  for (const e of result.errors) log(`  ✗ ${e.code}  ${e.msg}`);
  for (const w of result.warnings) log(`  ! ${w.code}  ${w.msg}`);
  return result.ok;
}
