// 验证四条架构承诺。跑：node test/determinism.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorld, quoteString } from '../src/parse.mjs';
import { compile, diff } from '../src/compile.mjs';
import { mockItems } from '../src/adapters/mock.mjs';
import { buildWorldFromItems, mergeWorld } from '../src/importer.mjs';

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

// 这份示例里的 pin 指向真实 bvid，而这里喂的是 mock 素材 ——
// 悬空 pin 现在会报错（以前是静默丢弃），所以先清掉。
// pin 的解析与报错由 test/validate.mjs 专门覆盖。
world.pins = [];

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
worldC.pins = [...world.pins, { item: 'mock_77', pos: [9, 0, -9], rot: 45 }];
const c1 = compile(worldC, items);
const dPin = diff(a1.ir, c1.ir);
check('D2 覆盖层：pin 只影响 1 件', dPin.moved.length === 1, `moved=${dPin.moved.length}`);

const pinned = c1.ir.regions.flatMap(r => r.exhibits).find(e => e.item === 'mock_77');
check('D2 覆盖层：pin 的坐标被精确写入', JSON.stringify(pinned.pos) === '[9,0,-9]' && pinned.rot === 45 && pinned.pinned === true);

// 承诺 4：世界是程序不是资产 —— 场景图极小
check('D3 零资产：场景图 < 64 KB', a1.stats.bytes < 64 * 1024, `${(a1.stats.bytes / 1024).toFixed(1)} KB / ${a1.stats.placed} 节点`);

// 承诺 5：增量可解释 —— diff 能指出谁动了
check('D4 空间 diff：能定位到具体展品和位移', dPin.moved[0]?.id === 'mock_77' && dPin.moved[0].distance > 0,
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
  wA.pins = [...world.pins, { item: 'mock_60', pos: [5, 0, -5], rot: 10 }];
  const wB = structuredClone(world);
  wB.pins = [...world.pins, { item: 'mock_60', pos: [5, 0, -5], rot: 55 }];
  const d = diff(compile(wA, items).ir, compile(wB, items).ir);
  check('A-05 只改旋转也能被 diff 识别', d.rotated.length === 1 && d.moved.length === 0,
    `rotated=${d.rotated.length} moved=${d.moved.length} Δ${d.rotated[0]?.delta ?? '-'}°`);
}

// A-03：素材身份必须来自内容本身，不能来自它在数组里的位置。
// 这条现在会失败 —— 失败是预期的，它描述的是「改完之后必须成立」的契约。
{
  const items = mockItems(12);
  const shifted = [{ ...items[0], title: '插到最前面的一条新收藏' }, ...items];
  const keysOld = items.slice(1).map(i => i.key);
  const keysNew = new Set(shifted.slice(1).map(i => i.key));
  const same = keysOld.every(k => k && keysNew.has(k));
  check('A-03 素材身份不随数组位置漂移', same, `旧 ${keysOld.length} 条 / 命中 ${keysNew.size} 个`);
}

// A-07：字符串转义必须能原样往返（引号、反斜杠、换行）
{
  const nasty = '他说"你好" \\ 然后\n换行';
  const w2 = parseWorld(`world ${quoteString(nasty)} {\n  seed 1\n}\n`);
  check('A-07 字符串转义往返一致', w2.name === nasty, JSON.stringify(w2.name).slice(0, 40));
}

// A-07 补充：importer 生成的源码必须能被自己的解析器读回来
{
  const { buildWorldFromItems } = await import('../src/importer.mjs');
  const tricky = [{ key: 'mock_x', title: '标题里有"引号"和\\反斜杠', year: 2024, owner: 'u', cover: 'mock://c' }];
  const built = await buildWorldFromItems(tricky, { title: 't"t', source: 's\\s', seedKey: 'esc' });
  let ok = true, msg = '';
  try { parseWorld(built.world); } catch (e) { ok = false; msg = e.message.slice(0, 40); }
  check('A-07 importer 产出的源码可被解析', ok, msg);
}

// A-06：块未闭合、} 之后还有内容，都必须报错而不是静默吞掉
{
  let e1 = '', e2 = '';
  try { parseWorld('world "a" {\n  seed 1\n'); } catch (e) { e1 = e.message; }
  try { parseWorld('world "a" {\n  seed 1\n}\nregion "b" { }\n'); } catch (e) { e2 = e.message; }
  check('A-06 未闭合的块会报错', /没有闭合/.test(e1), e1.slice(0, 24));
  check('A-06 尾随内容会报错', /多余内容/.test(e2), e2.slice(0, 28));
}

// ── 布局 v2：收藏夹更新时不重排 ─────────────────────────────
{
  const ten = mockItems(10, 'stable');
  const built = await buildWorldFromItems(ten, { title: '稳定测试', source: 'x', seedKey: 'fav1|稳定测试' });

  // 故意把新条目插到最前面 —— 这是下标式布局最怕的情况
  const fresh = mockItems(3, 'grow').map((it, i) => ({ ...it, key: `new_${i}`, ts: 1000 + i }));
  const grown = [...fresh, ...ten];

  const merged = await mergeWorld(parseWorld(built.world), ten, grown);

  const A = compile(parseWorld(built.world), ten).ir;
  const B = compile(parseWorld(merged.world), grown).ir;
  const posA = new Map(A.regions.flatMap(r => r.exhibits.map(e => [e.item, e.pos.join(',')])));
  const posB = new Map(B.regions.flatMap(r => r.exhibits.map(e => [e.item, e.pos.join(',')])));

  const moved = [...posA].filter(([k, v]) => posB.get(k) !== v).length;
  const d = diff(A, B);

  check('v2 增量导入：旧展品一件都不动', moved === 0, `${posA.size} 件 · 位移 ${moved}`);
  check('v2 增量导入：diff 只报 added',
    d.moved.length === 0 && d.rotated.length === 0 && d.added.length === 3,
    `moved ${d.moved.length} · rotated ${d.rotated.length} · added ${d.added.length}`);
  check('v2 源码声明算法版本', parseWorld(built.world).layoutVersion === 2,
    `layout ${parseWorld(built.world).layoutVersion} · irVersion ${A.irVersion}`);
}

// 同样两块状态，分两次导入与一次导入必须得到同一份源码
{
  const first = mockItems(8, 'batch-a');
  const built = await buildWorldFromItems(first, { title: '分批', source: 'x', seedKey: 'fav2|分批' });
  const more = mockItems(4, 'batch-b').map((it, i) => ({ ...it, key: `b_${i}`, ts: 5000 + i }));

  // 一次导入 12 条
  const all = await buildWorldFromItems([...first, ...more], { title: '分批', source: 'x', seedKey: 'fav2|分批' });
  // 先 8 条，再合并 4 条
  const step = await mergeWorld(parseWorld(built.world), first, [...first, ...more]);

  // 注意：两边的 hash 本来就不同 —— 合并出来的源码会给新条目打 fresh，
  // 而一次导入不会。这里比的是「布局」是否一致，不是源码是否逐字相同。
  const posOf = (w) => {
    const ir = compile(parseWorld(w), [...first, ...more]).ir;
    return [...ir.regions.flatMap(r => r.exhibits)]
      .map(e => `${e.item}@${e.pos.join(',')}`).sort().join('|');
  };
  const same = posOf(all.world) === posOf(step.world);
  check('v2 分批导入与一次导入落位一致', same, same ? '逐件坐标相同' : '有差异');
}

// v2 的三种错法都必须报错，而不是悄悄挪走别人
{
  const items = mockItems(5, 'edge');
  const src = body => `world "边界" {\n  seed 1\n  layout 2\n  region "r" {\n    layout grid 2 3\n${body}  }\n}\n`;
  let e1 = '', e2 = '', e3 = '';
  try { compile(parseWorld(src('    place "nope" 0 0\n')), items); } catch (e) { e1 = e.message; }
  try { compile(parseWorld(src('    place "mock_0" 0 0\n    place "mock_1" 0 0\n')), items); } catch (e) { e2 = e.message; }
  try { compile(parseWorld(src('    place "mock_0" 9 9\n')), items); } catch (e) { e3 = e.message; }

  check('v2 place 引用不存在的展品 → 报错', /不存在的展品/.test(e1), e1.slice(0, 20));
  check('v2 两件抢同一格 → 报错', /都落在格子/.test(e2), e2.slice(0, 20));
  check('v2 place 超出 grid → 报错', /超出 grid/.test(e3), e3.slice(0, 20));
}

// fresh：新收藏的标记要一路传到 IR，前端才知道该藏哪几件
{
  const items = mockItems(4, 'fr');
  const src = [
    'world "新收藏" {',
    '  seed 3',
    '  layout 2',
    '  region "r" {',
    '    layout grid 2 4',
    '    place "mock_0" 0 0 fresh',
    '    place "mock_1" 0 1',
    '  }',
    '}',
    '',
  ].join('\n');

  const w = parseWorld(src);
  check('place 的 fresh 后缀被解析', w.regions[0].places[0].fresh === true && w.regions[0].places[1].fresh === false);

  const ir = compile(w, items).ir;
  const ex = ir.regions[0].exhibits;
  check('fresh 传到 IR，且只标一件', ex.find(e => e.item === 'mock_0')?.fresh === true && !ex.find(e => e.item === 'mock_1')?.fresh);

  // 合并导入：新加入的自动带 fresh，老的不变
  const base = mockItems(6, 'merge');
  const built = await buildWorldFromItems(base, { title: '合并', source: 'x', seedKey: 'k1' });
  const fresh2 = mockItems(2, 'new').map((it, i) => ({ ...it, key: `new_${i}`, ts: 9000 + i }));
  const merged = await mergeWorld(parseWorld(built.world), base, [...base, ...fresh2]);
  const hasFresh = merged.world.split('\n').filter(l => /place .* fresh$/.test(l)).length;
  check('合并导入：新条目自动标记 fresh', hasFresh === 2, `带 fresh 的 place ${hasFresh} 条`);
}

// v1 冻结：没有 layout 指令的旧文件，IR 结构一字不改
{
  const v1 = 'world "旧世界" {\n  seed 7\n  region "r" {\n    take 0..2\n    layout grid 2 3\n  }\n}\n';
  const ir = compile(parseWorld(v1), mockItems(5, 'v1')).ir;
  check('v1 旧文件不受 v2 影响',
    parseWorld(v1).layoutVersion === 1 && ir.irVersion === 1 && !('layoutVersion' in ir),
    `irVersion ${ir.irVersion} · 无 layoutVersion 字段`);
}

console.log('');
console.log(`  ${pass} 通过 · ${fail} 失败`);
console.log('');

process.exit(fail === 0 ? 0 : 1);
