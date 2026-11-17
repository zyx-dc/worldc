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
const frames = glb.nodes.filter(n => /^frame_\d+$/.test(n.name || ''));
const glbIds = new Set(frames.map(n => Number(n.name.split('_')[1])));

const world = parseWorld(readFileSync(P('examples/bilibili-demo.world'), 'utf8'));
const items = JSON.parse(readFileSync(P('examples/bilibili-demo.items.json'), 'utf8'));
const { ir } = compile(world, items);
const irIds = new Set(ir.regions.flatMap(r => r.exhibits.map(e => e.item)));

console.log(`  glb ${frames.length} 个画框 · IR ${irIds.size} 件展品\n`);

// 1. 一一对应
check('glb 节点与 IR 展品一一对应', glbIds.size === irIds.size &&
  [...glbIds].every(id => irIds.has(id)) && [...irIds].every(id => glbIds.has(id)),
  `glb ${glbIds.size} / IR ${irIds.size}`);

// 2. glb 里不该有材质（封面运行时贴）
check('glb 不含材质（封面由网页端贴）', (glb.materials || []).length === 0,
  `${(glb.materials || []).length} 个材质`);

// 3. 每个展区恰好一幅主画
const heroes = frames.filter(n => n.extras?.hero);
check('主画数量与展区数一致', heroes.length === ir.regions.length,
  `${heroes.length} 幅 / ${ir.regions.length} 区`);

// 4. extras 里的 region 与 IR 一致
const badRegion = frames.filter(n => {
  const e = ir.regions.flatMap(r => r.exhibits.map(x => ({ ...x, rn: r.name }))).find(x => x.item === Number(n.name.split('_')[1]));
  return e && n.extras?.region !== e.rn;
});
check('extras.region 与 IR 展区一致', badRegion.length === 0, badRegion.length ? `${badRegion.length} 处不符` : '全部一致');

// 5. pin 写回：星海模式下 pos 就是世界坐标，编译后必须原样保留
const pinX = 12.345, pinZ = -67.891, pinRot = 37;
const w2 = structuredClone(world);
w2.pins = [{ item: 7, pos: [pinX, 0, pinZ], rot: pinRot }];
const { ir: ir2 } = compile(w2, items);
const ex = ir2.regions.flatMap(r => r.exhibits).find(e => e.item === 7);
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
    const id = Number(n.name.split('_')[1]);
    const l = byId.get(id);
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
