// 星海后端 · M1
// 职责：加载 Blender 建好的场（glb）、按 id 贴真实封面、加上外缘辉光。
// 水面反射留给 M2；这里只保证「能在浏览器里看到同一片海」。

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);

// ── 渲染器 / 场景 / 相机（数值见 spec §4） ──────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x03060c, 1);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x071226, 0.0035);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
camera.rotation.order = 'YXZ';
camera.position.set(Number(q.get('x') ?? 0), 3.0, Number(q.get('z') ?? 6));

// ── 星空：烘好的 equirect，直接当背景与环境 ──────────────────
const sky = await new THREE.TextureLoader().loadAsync('./assets/sky.jpg');
sky.mapping = THREE.EquirectangularReflectionMapping;
sky.colorSpace = THREE.SRGBColorSpace;
scene.background = sky;

// ── IR 元数据：只用来查标题/封面/色相，坐标一律以 glb 为准 ────
const ir = await fetch('../build/scene.json').then(r => {
  if (!r.ok) throw new Error(`读不到 build/scene.json（HTTP ${r.status}），先跑 node src/cli.mjs build ...`);
  return r.json();
});
$('worldName').textContent = ir.world;

const metaById = new Map();
for (const r of ir.regions) {
  for (const e of r.exhibits) metaById.set(e.item, { ...e, hue: r.hue, region: r.name });
}

// ── 贴图工具 ────────────────────────────────────────────────
function wrapText(g, text, x, y, maxW, lh, maxLines = 3) {
  let line = '', row = 0;
  for (const ch of text) {
    const test = line + ch;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y + row * lh);
      row++;
      line = ch;
      if (row >= maxLines) { g.fillText(line.slice(0, -1) + '…', x, y + row * lh); return; }
    } else {
      line = test;
    }
  }
  if (line) g.fillText(line, x, y + row * lh);
}

/** 封面还没到（或断网）时的程序化底图：该区色相 + 标题 */
function placeholderTexture(info, hue) {
  const W = 512, H = 288;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const h = (hue + 350) % 360;
  g.fillStyle = `hsl(${h} 34% 9%)`;
  g.fillRect(0, 0, W, H);
  g.fillStyle = `hsl(${(h + 18) % 360} 40% 15%)`;
  g.beginPath();
  g.moveTo(0, H); g.lineTo(W * 0.6, H); g.lineTo(W, H * 0.3); g.lineTo(W, H);
  g.closePath(); g.fill();

  g.fillStyle = 'rgba(226,234,246,.72)';
  g.font = '500 26px "PingFang SC","Microsoft YaHei",sans-serif';
  wrapText(g, info.title || `#${info.item}`, 26, 72, W - 56, 36);

  g.fillStyle = 'rgba(150,170,196,.45)';
  g.font = '400 17px "PingFang SC",sans-serif';
  g.fillText(String(info.year ?? ''), 26, H - 28);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return alignUv(tex);
}

/** 辉光用的径向渐变 */
/**
 * glb 的 UV 是标准 glTF 约定（V 向下，uv(0,0) 在画框左上）。
 * 但 TextureLoader 默认 flipY=true（V 向上），直接用会让整张图上下颠倒。
 * 这里对齐回 glTF 约定 —— 只翻 V，不翻 U。
 */
function alignUv(tex) {
  tex.flipY = false;
  return tex;
}

const HALO = (() => {  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,.95)');
  grd.addColorStop(0.28, 'rgba(255,255,255,.42)');
  grd.addColorStop(0.62, 'rgba(255,255,255,.11)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// ── 加载建好的场 ────────────────────────────────────────────
const gltf = await new GLTFLoader().loadAsync('./assets/space.glb');
scene.add(gltf.scene);
gltf.scene.updateMatrixWorld(true);

const panels = [];       // { mesh, id, hero, region, center, size }
const seen = new Set();
const box = new THREE.Box3();
const tmpQ = new THREE.Quaternion();
const normal = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
// 这个面的顶点法线是局部 +Y（POSITION 躺在 XZ 平面），不是 three 默认的 +Z
const PLANE_FRONT = new THREE.Vector3(0, 1, 0);

gltf.scene.traverse((o) => {
  const m = /^frame_(\d+)$/.exec(o.name || '');
  if (!m) return;

  const id = Number(m[1]);
  if (seen.has(id)) return;

  let mesh = o.isMesh ? o : null;
  if (!mesh) o.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
  if (!mesh) return;
  seen.add(id);

  const info = metaById.get(id) || { item: id, title: `#${id}`, hue: 210, region: '' };
  const hero = !!(o.userData?.hero ?? info.hero);

  mesh.material = new THREE.MeshBasicMaterial({
    map: placeholderTexture(info, info.hue),
    toneMapped: false,
    // 默认双面（防止某些画框背对时直接消失）；?side=front 用于排查朝向
    side: q.get('side') === 'front' ? THREE.FrontSide : THREE.DoubleSide,
  });

  box.setFromObject(mesh);
  let size = box.getSize(new THREE.Vector3());
  let center = box.getCenter(new THREE.Vector3());

  // 朝向修正：建场时画框朝的是 Blender 里的机位，转换后有个别会背对相机，
  // 双面材质会把背面翻上来（文字镜像）。这里按世界法线判一次，背对就绕世界 Y 转 180°。
  normal.copy(PLANE_FRONT).applyQuaternion(mesh.getWorldQuaternion(tmpQ));
  const toCam = camera.position.clone().sub(center).normalize();
  if (normal.dot(toCam) < 0) {
    mesh.rotateOnWorldAxis(WORLD_UP, Math.PI);
    mesh.updateMatrixWorld(true);
    normal.copy(PLANE_FRONT).applyQuaternion(mesh.getWorldQuaternion(tmpQ));
    box.setFromObject(mesh);
    size = box.getSize(new THREE.Vector3());
    center = box.getCenter(new THREE.Vector3());
  }

  // 外缘辉光：挂在画框「背后」一点，靠深度测试让中心被画框挡住，只露外圈
  const factors = hero ? [[2.0, 0.34], [3.5, 0.12]] : [[1.6, 0.16]];
  normal.set(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(tmpQ));

  const tint = new THREE.Color().setHSL(info.hue / 360, 0.5, 0.62, THREE.SRGBColorSpace);
  for (const [f, opacity] of factors) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: HALO,
      color: tint,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    sp.position.copy(center).addScaledVector(normal, -0.3);
    sp.scale.set(size.x * f, size.y * f, 1);
    scene.add(sp);
  }

  panels.push({ mesh, id, hero, size, center: center.clone(), region: info.region });
});

// ── 真实封面：并发 6，失败就保留程序化底图 ────────────────────
const texLoader = new THREE.TextureLoader();
const queue = [];
let active = 0;

for (const p of panels) {
  const info = metaById.get(p.id);
  if (!info || typeof info.cover !== 'string' || !/^https?:/i.test(info.cover)) continue;
  queue.push({ url: `/img?u=${encodeURIComponent(info.cover)}`, mesh: p.mesh });
}

function pump() {
  while (active < 6 && queue.length) {
    const job = queue.shift();
    active++;
    texLoader.load(job.url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      alignUv(tex);
      const mat = job.mesh.material;
      if (mat.map) mat.map.dispose();
      mat.map = tex;
      mat.needsUpdate = true;
      active--;
      pump();
    }, undefined, () => { active--; pump(); });
  }
}
pump();

// ── 极简操作：拖动环顾 + WASD（M1 只为看画面，不做碰撞） ──────
let yaw = 0, pitch = 0, dragging = false, lastX = 0, lastY = 0;
const keys = Object.create(null);

const gate = $('gate');
gate.addEventListener('click', () => gate.classList.add('gone'));
if (q.get('gate') === '0') { gate.classList.add('gone'); gate.style.display = 'none'; }
if (q.get('hud') === '0') {
  document.querySelectorAll('.hud').forEach(el => { el.style.display = 'none'; });
  $('vig').style.display = 'none';
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  dragging = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.003;
  pitch -= (e.clientY - lastY) * 0.003;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
  lastX = e.clientX; lastY = e.clientY;
});

addEventListener('keydown', (e) => { keys[e.code] = true; });
addEventListener('keyup', (e) => { keys[e.code] = false; });

// ── 主循环 ─────────────────────────────────────────────────
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
let hudFrame = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const speed = (keys.ShiftLeft || keys.ShiftRight) ? 9 : 4.2;

  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1;
  if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1;

  if (mx || mz) {
    const len = Math.hypot(mx, mz);
    camera.position.addScaledVector(fwd, (mz / len) * speed * dt);
    camera.position.addScaledVector(right, (mx / len) * speed * dt);
  }
  camera.position.y = 3.0;
  camera.rotation.set(pitch, yaw, 0);

  if ((hudFrame++ & 7) === 0) updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

/** 左下角显示离你最近的展区 */
function updateHud() {
  let best = null, bestD = Infinity;
  for (const p of panels) {
    const d = p.center.distanceToSquared(camera.position);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) return;
  const info = metaById.get(best.id) || {};
  $('regionName').textContent = best.region || '星海';
  $('regionMeta').textContent = `${info.year ?? ''}　${panels.length} 件`;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

tick();

window.space = { scene, camera, renderer, panels, gltf };
