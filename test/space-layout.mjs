// 星海模式的回归测试：glb 与 IR 的对应关系、pin 写回的落点精度。
// 跑：node test/space-layout.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorld } from '../src/parse.mjs';
import { compile } from '../src/compile.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...s) => join(root, ...s);

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ·  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ·  ' + detail : ''}`); }
}

function readGlb(path) {
  const buf = readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('不是合法的 glb');
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

console.log('\n  worldc · 星海布局回归');
console.log('  ' + '─'.repeat(58));

const glb = readGlb(P('viewer/assets/space.glb'));
// 节点名是 frame_<key>，key 本身含下划线（bv_BV1bc…），所以只能去掉前缀、不能 split
const keyOf = name => String(name).replace(/^frame_/, '');
const frames = glb.nodes.filter(n => /^frame_.+$/.test(n.name || ''));
const glbIds = new Set(frames.map(n => keyOf(n.name)));

// demo 的真实 items.json 含第三方内容，不入库。
// 干净克隆时改用可入库的离线示例跑结构断言；
// 与「已提交 glb」相关的几条只能 SKIP —— 那个 glb 是用真实收藏夹生成的。
const hasRealItems = existsSync(P('examples/bilibili-demo.items.json'));

const worldPath = hasRealItems ? 'examples/bilibili-demo.world' : 'examples/offline-demo.world';
const itemsPath = hasRealItems ? 'examples/bilibili-demo.items.json' : 'examples/offline-demo.items.json';

const world = parseWorld(readFileSync(P(worldPath), 'utf8'));
const items = JSON.parse(readFileSync(P(itemsPath), 'utf8'));

if (!hasRealItems) {
  console.log('  注意：未找到 demo 的 items.json，改用 examples/offline-demo（合成数据）——');
  console.log('        结构断言照跑，与已提交 glb 对齐的几条会 SKIP。\n');
}

const { ir } = compile(world, items);
const irIds = new Set(ir.regions.flatMap(r => r.exhibits.map(e => e.item)));

console.log(`  glb ${frames.length} 个画框 · IR ${irIds.size} 件展品（${worldPath}）\n`);

// 1. 一一对应
if (hasRealItems) {
  check('glb 节点与 IR 展品一一对应', glbIds.size === irIds.size &&
    [...glbIds].every(id => irIds.has(id)) && [...irIds].every(id => glbIds.has(id)),
    `glb ${glbIds.size} / IR ${irIds.size}`);
} else {
  console.log('  SKIP  glb 与 IR 一一对应（需要 demo 的真实 items.json）');
}

// 2. glb 里不该有材质（封面运行时贴）
check('glb 不含材质（封面由网页端贴）', (glb.materials || []).length === 0,
  `${(glb.materials || []).length} 个材质`);

// 3. 每个展区恰好一幅主画
if (hasRealItems) {
  const heroes = frames.filter(n => n.extras?.hero);
  check('主画数量与展区数一致', heroes.length === ir.regions.length,
    `${heroes.length} 幅 / ${ir.regions.length} 区`);
} else {
  console.log('  SKIP  主画数量（glb 属于真实收藏夹那份世界）');
}

// 4. extras 里的 region 与 IR 一致
if (hasRealItems) {
  const badRegion = frames.filter(n => {
    const e = ir.regions.flatMap(r => r.exhibits.map(x => ({ ...x, rn: r.name }))).find(x => x.item === keyOf(n.name));
    return e && n.extras?.region !== e.rn;
  });
  check('extras.region 与 IR 展区一致', badRegion.length === 0, badRegion.length ? `${badRegion.length} 处不符` : '全部一致');
} else {
  console.log('  SKIP  extras.region（同上）');
}

// 5. pin 写回：星海模式下 pos 就是世界坐标，编译后必须原样保留
const pinX = 12.345, pinZ = -67.891, pinRot = 37;
const w2 = structuredClone(world);
const someKey = [...irIds][7];
w2.pins = [{ item: someKey, pos: [pinX, 0, pinZ], rot: pinRot }];
const { ir: ir2 } = compile(w2, items);
const ex = ir2.regions.flatMap(r => r.exhibits).find(e => e.item === someKey);
const dx = Math.abs(ex.pos[0] - pinX);
const dz = Math.abs(ex.pos[2] - pinZ);
check('pin 落点误差 < 1e-3', dx < 1e-3 && dz < 1e-3 && ex.rot === pinRot && ex.pinned === true,
  `Δx=${dx.toExponential(1)} Δz=${dz.toExponential(1)}`);

// 6. 旧后端的 centerZ 偏移：确认它确实存在，星海路径不能走这条
const layoutSrc = readFileSync(P('src/world-layout.mjs'), 'utf8');
check('世界坐标只由 space.js 自己处理（world-layout 仍会加 centerZ）',
  /wz:\s*cursor - d \/ 2 \+ e\.pos\[2\]/.test(layoutSrc),
  '这是旧后端的语义，星海不复用它');

// 7. 布局文件（如果生成过）与 glb 位置一致
const layoutPath = P('build/space-layout.json');
if (existsSync(layoutPath)) {
  const lay = JSON.parse(readFileSync(layoutPath, 'utf8'));
  const list = Array.isArray(lay) ? lay : (lay.frames || lay.items || []);
  const byId = new Map(list.map(x => [x.item ?? x.id, x]));
  let mismatch = 0;
  for (const n of frames) {
    const l = byId.get(keyOf(n.name));
    if (!l) continue;
    const p = l.pos || l.position || [0, 0, 0];
    const t = n.translation || [0, 0, 0];
    // Blender(x, 纵深, 高) → glTF(x, 高, -纵深)
    if (Math.abs(p[0] - t[0]) > 1e-3 || Math.abs(p[2] - -t[2]) > 1e-3) mismatch++;
  }
  check('space-layout.json 与 glb 节点位置一致', mismatch === 0, mismatch ? `${mismatch} 处不符` : '全部一致');
} else {
  console.log('  SKIP  space-layout.json 未生成（跑一次 Blender 脚本可启用这条）');
}

console.log('');
console.log(`  ${pass} 通过 · ${fail} 失败`);
console.log('');

process.exit(fail === 0 ? 0 : 1);
