// 验证四条架构承诺。跑：node test/determinism.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorld } from '../src/parse.mjs';
import { compile, diff } from '../src/compile.mjs';
import { mockItems } from '../src/adapters/mock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ·  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ·  ' + detail : ''}`); }
}

const src = readFileSync(join(root, 'examples/my-favorites.world'), 'utf8');
const world = parseWorld(src);
const items = mockItems(world.items, 'mock-v1:120');

console.log('\n  worldc · 架构承诺验证');
console.log('  ' + '─'.repeat(58));
console.log(`  源文件 ${src.split('\n').length} 行 · ${(Buffer.byteLength(src) / 1024).toFixed(1)} KB`);
console.log('');

// 承诺 1：确定性 —— 同一份源文件，编译一万次都是同一个世界
const a1 = compile(world, items);
const a2 = compile(world, items);
check('D1 确定性：两次编译 hash 一致', a1.hash === a2.hash, a1.hash.slice(0, 16));

// 承诺 2：种子敏感 —— 换种子必须是另一个世界
const worldB = structuredClone(world);
worldB.seed = 0x51b7e4;
const b1 = compile(worldB, items);
check('D1 种子敏感：换 seed 得到不同世界', a1.hash !== b1.hash, b1.hash.slice(0, 16));

const dSeed = diff(a1.ir, b1.ir);
check('D1 换种子让所有展品重新布局', dSeed.moved.length > 100, `${dSeed.moved.length} 件位移`);

// 承诺 3：覆盖层 —— 手挪一件，只动那一件
const worldC = structuredClone(world);
worldC.pins = [...world.pins, { item: 77, pos: [9, 0, -9], rot: 45 }];
const c1 = compile(worldC, items);
const dPin = diff(a1.ir, c1.ir);
check('D2 覆盖层：pin 只影响 1 件', dPin.moved.length === 1, `moved=${dPin.moved.length}`);

const pinned = c1.ir.regions.flatMap(r => r.exhibits).find(e => e.item === 77);
check('D2 覆盖层：pin 的坐标被精确写入', JSON.stringify(pinned.pos) === '[9,0,-9]' && pinned.rot === 45 && pinned.pinned === true);

// 承诺 4：世界是程序不是资产 —— 场景图极小
check('D3 零资产：场景图 < 64 KB', a1.stats.bytes < 64 * 1024, `${(a1.stats.bytes / 1024).toFixed(1)} KB / ${a1.stats.placed} 节点`);

// 承诺 5：增量可解释 —— diff 能指出谁动了
check('D4 空间 diff：能定位到具体展品和位移', dPin.moved[0]?.id === 77 && dPin.moved[0].distance > 0,
  dPin.moved[0] ? `#${dPin.moved[0].id} 位移 ${dPin.moved[0].distance}` : '无');

// ── 审计整改回归（对应报告 A-02 / A-05） ──────────────────────
// A-02：seed 不能掺 items.length，否则收藏夹多一条就让整片星海重排
{
  const { buildWorldFromItems } = await import('../src/importer.mjs');
  const base = mockItems(24);
  const opt = { title: 't', source: 'test', seedKey: 'same-world' };
  const s10 = (await buildWorldFromItems(base.slice(0, 10), opt)).seed;
  const s11 = (await buildWorldFromItems(base.slice(0, 11), opt)).seed;
  check('A-02 增删素材不改变 seed', s10 === s11, `10 条=${s10} / 11 条=${s11}`);
}

// A-05：只转不移也要被 diff 记录到，否则「转了一下」等于没发生
{
  const wA = structuredClone(world);
  wA.pins = [...world.pins, { item: 60, pos: [5, 0, -5], rot: 10 }];
  const wB = structuredClone(world);
  wB.pins = [...world.pins, { item: 60, pos: [5, 0, -5], rot: 55 }];
  const d = diff(compile(wA, items).ir, compile(wB, items).ir);
  check('A-05 只改旋转也能被 diff 识别', d.rotated.length === 1 && d.moved.length === 0,
    `rotated=${d.rotated.length} moved=${d.moved.length} Δ${d.rotated[0]?.delta ?? '-'}°`);
}

console.log('');
console.log(`  ${pass} 通过 · ${fail} 失败`);
console.log('');

process.exit(fail === 0 ? 0 : 1);
