// 3D 后端 + 编辑器。
// 展品坐标全部来自 IR；这里只负责「画出来」和「把改动写回源码」。

import * as THREE from './vendor/three.module.js';
import { parseWorld } from '../src/parse.mjs';
import { compile } from '../src/compile.mjs';
import { placeRegions, cameraStart, regionAt } from '../src/world-layout.mjs';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const EDIT = q.get('edit') === '1';
const fmt = n => String(Number(Number(n).toFixed(2)));

const getJson = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
  return r.json();
};
const getText = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
  return r.text();
};

// ── 数据 ──────────────────────────────────────────────────
let ir = await getJson('../build/scene.json');
let items = [];
let srcText = '';

if (EDIT) {
  items = await getJson('../build/scene.items.json');
  srcText = await getText('../build/scene.world');
}

let layout = placeRegions(ir);
const start = cameraStart(layout);

// ── 渲染器 ────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x08090c, 1);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x08090c, 8, 46);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 400);
camera.rotation.order = 'YXZ';
camera.position.set(start.x, start.y, start.z);

scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0c12, 0.45));
const dl = new THREE.DirectionalLight(0xffffff, 0.9);
dl.position.set(6, 14, 6);
scene.add(dl);

const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

// ── 贴图 ──────────────────────────────────────────────────
const GLOW = (() => {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.32, 'rgba(255,255,255,.42)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
})();

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

function coverTexture(item, hue) {
  const W = 384, H = 216;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');

  const h = (hue + ((item.item * 37) % 34) - 17 + 360) % 360;
  g.fillStyle = `hsl(${h} 42% 20%)`;
  g.fillRect(0, 0, W, H);

  g.fillStyle = `hsl(${(h + 26) % 360} 55% 31%)`;
  g.beginPath();
  g.moveTo(0, H); g.lineTo(W * 0.52, H); g.lineTo(W, H * 0.22); g.lineTo(W, H);
  g.closePath(); g.fill();

  g.strokeStyle = `hsla(${h} 60% 70% / .35)`;
  g.lineWidth = 1;
  g.strokeRect(12.5, 12.5, W - 25, H - 25);

  g.fillStyle = 'rgba(255,255,255,.95)';
  g.font = '500 26px "PingFang SC","Microsoft YaHei",sans-serif';
  wrapText(g, item.title || `#${item.item}`, 24, 62, W - 52, 34);

  g.fillStyle = 'rgba(255,255,255,.5)';
  g.font = '400 17px "PingFang SC",sans-serif';
  g.fillText(String(item.year ?? ''), 24, H - 26);
  g.textAlign = 'right';
  g.fillText(`#${item.item}`, W - 24, H - 26);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  return tex;
}

// ── 封面加载队列 ──────────────────────────────────────────
const texLoader = new THREE.TextureLoader();
const coverQueue = [];
let coverActive = 0;
let coverGen = 0;

function pumpCovers() {
  while (coverActive < 4 && coverQueue.length) {
    const job = coverQueue.shift();
    coverActive++;
    texLoader.load(job.url, (tex) => {
      coverActive--;
      if (job.gen === coverGen) {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = MAX_ANISO;
        job.apply(tex);
      }
      pumpCovers();
    }, undefined, () => { coverActive--; pumpCovers(); });
  }
}

// ── 共享几何 ──────────────────────────────────────────────
const panelGeo = new THREE.PlaneGeometry(1.7, 0.96);
const plinthGeo = new THREE.BoxGeometry(0.07, 0.92, 0.07);
const plinthMat = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.75, metalness: 0.3 });
const poolGeo = new THREE.PlaneGeometry(4.4, 4.4);

// ── 世界构建（可反复调用） ────────────────────────────────
let worldRoot = null;
let panels = [];
let tipFor = null;

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry && o.geometry !== panelGeo && o.geometry !== plinthGeo && o.geometry !== poolGeo) {
      o.geometry.dispose();
    }
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map && m.map !== GLOW) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function buildWorld(nextIr) {
  ir = nextIr;
  layout = placeRegions(ir);
  coverGen++;
  coverQueue.length = 0;
  tipFor = null;
  $('tip').classList.remove('on');

  if (worldRoot) { scene.remove(worldRoot); disposeTree(worldRoot); }
  worldRoot = new THREE.Group();
  scene.add(worldRoot);
  panels = [];

  $('worldName').textContent = ir.world;

  const zTop = layout.regions[0].zNear + 8;
  const zBottom = layout.regions.at(-1).zFar - 5;

  // 走廊盒（只画内面）：把虚空变成展厅
  const hall = new THREE.Mesh(
    new THREE.BoxGeometry(layout.maxWidth + 3, 5.2, zTop - zBottom),
    new THREE.MeshBasicMaterial({ color: 0x0e1219, side: THREE.BackSide })
  );
  hall.position.set(0, 2.6, (zTop + zBottom) / 2);
  worldRoot.add(hall);

  // 地面网格：提供透视纵深参照
  const grid = new THREE.GridHelper(220, 110, 0x1a2431, 0x121a24);
  grid.position.y = 0.025;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  worldRoot.add(grid);

  for (const r of layout.regions) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(r.w, r.d),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(r.hue / 360, 0.30, 0.052, THREE.SRGBColorSpace),
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.01, r.centerZ);
    worldRoot.add(floor);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(r.w, r.d)),
      new THREE.LineBasicMaterial({ color: new THREE.Color().setHSL(r.hue / 360, 0.58, 0.34, THREE.SRGBColorSpace) })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(0, 0.02, r.centerZ);
    worldRoot.add(edge);

    for (const e of r.exhibits) {
      const mat = new THREE.MeshBasicMaterial({ map: coverTexture(e, r.hue), toneMapped: false });
      const panel = new THREE.Mesh(panelGeo, mat);
      panel.position.set(e.wx, 1.44, e.wz);
      panel.rotation.y = THREE.MathUtils.degToRad(e.rot || 0);
      panel.userData = { title: e.title, year: e.year, item: e.item, owner: e.owner, region: r.name, pinned: e.pinned, centerZ: r.centerZ };
      worldRoot.add(panel);
      panels.push(panel);

      if (typeof e.cover === 'string' && /^https?:/i.test(e.cover)) {
        coverQueue.push({
          url: `/img?u=${encodeURIComponent(e.cover)}`,
          gen: coverGen,
          apply: (tex) => {
            if (mat.map) mat.map.dispose();
            mat.map = tex;
            mat.needsUpdate = true;
          },
        });
      }

      const plinth = new THREE.Mesh(plinthGeo, plinthMat);
      plinth.position.set(e.wx, 0.46, e.wz);
      worldRoot.add(plinth);

      const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({
        map: GLOW,
        color: new THREE.Color().setHSL(r.hue / 360, 0.55, 0.42, THREE.SRGBColorSpace),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(e.wx, 0.035, e.wz);
      worldRoot.add(pool);
    }
  }

  pumpCovers();
}

// 编辑模式不预先建世界：编辑器会用源码编译一次，避免白白建两遍（纹存翻倍会直接把渲染器撑爆）
if (!EDIT) buildWorld(ir);

// ── 编辑器 ────────────────────────────────────────────────
const ta = $('src');
const estat = $('estat');
let compileTimer = null;

function setStatus(text, bad = false) {
  estat.textContent = text;
  estat.classList.toggle('bad', bad);
}

function recompile() {
  const t0 = performance.now();
  try {
    const w = parseWorld(srcText);
    const { ir: next, hash, stats } = compile(w, items);
    buildWorld(next);
    setStatus(`${hash.slice(0, 12)} · ${stats.placed} 件 · ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function scheduleCompile(delay = 220) {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(recompile, delay);
}

/** 把一次拖动写回源码：有就改，没有就追加 */
function upsertPin(itemId, x, z, rotDeg) {
  const line = `  pin item:${itemId} at ${fmt(x)} 0 ${fmt(z)} rot ${rotDeg}`;
  const re = new RegExp(`^[ \\t]*pin item:${itemId}\\b.*$`, 'm');
  if (re.test(srcText)) {
    srcText = srcText.replace(re, line);
  } else {
    srcText = srcText.replace(/(\n)\s*\}\s*$/, `$1${line}\n}\n`);
  }
  ta.value = srcText;
  scheduleCompile(0);
}

if (EDIT) {
  ta.value = srcText;
  $('editor').classList.add('on');
  $('cross').style.display = 'none';
  $('gate').style.display = 'none';
  gate0();
  recompile();

  ta.addEventListener('input', () => {
    srcText = ta.value;
    scheduleCompile();
  });
} else {
  setStatus('');
}

function gate0() {
  const g = $('gate');
  if (g) g.classList.add('gone');
}

// ── 第一人称控制 ─────────────────────────────────────────
const keys = Object.create(null);
let yaw = 0, pitch = 0, locked = false, auto = false;

const gate = $('gate');
gate.addEventListener('click', () => {
  if (EDIT) { gate.classList.add('gone'); return; }
  renderer.domElement.requestPointerLock();
});
renderer.domElement.addEventListener('click', () => {
  if (EDIT) return;
  renderer.domElement.requestPointerLock();
});

if (q.get('gate') === '0') { gate.classList.add('gone'); gate.style.display = 'none'; }
if (q.get('auto') === '1') auto = true;
if (q.get('hud') === '0') document.querySelectorAll('.hud, #cross').forEach(el => { el.style.display = 'none'; });
if (q.has('z')) camera.position.z = Number(q.get('z'));
if (q.has('x')) camera.position.x = Number(q.get('x'));

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  gate.classList.toggle('gone', locked);
});

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
});

addEventListener('keydown', (e) => {
  if (e.target === ta) return;          // 在编辑器里打字时不要触发快捷键
  keys[e.code] = true;
  if (e.code === 'KeyR') auto = !auto;
  if (e.code === 'KeyE') location.href = EDIT ? './?gate=0' : './?edit=1';
  if (e.code === 'Escape' && EDIT) location.href = './?gate=0';
  if (e.code === 'Tab' && EDIT) e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (e.target === ta) return;
  keys[e.code] = false;
});

// ── 拖拽展板（仅编辑模式） ────────────────────────────────
const ndc = new THREE.Vector2();
const pickRay = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();
let dragObj = null;
let lookDrag = null;

function setNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!EDIT) return;
  setNdc(e);
  pickRay.setFromCamera(ndc, camera);
  const hit = pickRay.intersectObjects(panels, false)[0];
  if (hit) {
    dragObj = hit.object;
    dragObj.userData.dirty = false;
    renderer.domElement.setPointerCapture(e.pointerId);
  } else {
    lookDrag = { x: e.clientX, yaw };
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!EDIT) return;
  if (dragObj) {
    setNdc(e);
    pickRay.setFromCamera(ndc, camera);
    if (pickRay.ray.intersectPlane(groundPlane, hitPoint)) {
      const half = layout.maxWidth / 2 - 0.8;
      dragObj.position.x = Math.max(-half, Math.min(half, hitPoint.x));
      dragObj.position.z = hitPoint.z;
      dragObj.userData.dirty = true;
    }
  } else if (lookDrag) {
    yaw = lookDrag.yaw - (e.clientX - lookDrag.x) * 0.005;
  }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragObj) {
    if (dragObj.userData.dirty) {
      const d = dragObj.userData;
      const rot = Math.round(THREE.MathUtils.radToDeg(dragObj.rotation.y));
      // pos[2] 是展区局部 z，而拖拽拿到的是世界 z —— 必须减掉 centerZ，
      // 否则写回去的 pin 在重编译后会被再加一次 centerZ，落点跳开一整段展区。
      const localZ = dragObj.position.z - d.centerZ;
      upsertPin(d.item, dragObj.position.x, localZ, rot);
    }
    dragObj = null;
  }
  lookDrag = null;
});

// ── 工具提示 ─────────────────────────────────────────────
const ray = new THREE.Raycaster();
ray.far = 6.5;

function lookAtPanel() {
  if (EDIT) return;
  ray.setFromCamera({ x: 0, y: 0 }, camera);
  const hit = ray.intersectObjects(panels, false)[0];
  if (hit && hit.object !== tipFor) {
    tipFor = hit.object;
    const d = hit.object.userData;
    $('tipTitle').textContent = d.title;
    $('tipMeta').textContent = `${d.region} · ${d.year}${d.owner ? ' · ' + d.owner : ''} · #${d.item}${d.pinned ? ' · 已钉选' : ''}`;
    $('tip').classList.add('on');
  } else if (!hit && tipFor) {
    tipFor = null;
    $('tip').classList.remove('on');
  }
}

// ── 主循环 ───────────────────────────────────────────────
const clock = new THREE.Clock();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
let bob = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const speed = (keys.ShiftLeft || keys.ShiftRight ? 9 : 4.2);

  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1;
  if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1;
  if (auto && !EDIT) mz += 0.45;

  const len = Math.hypot(mx, mz) || 1;
  if (mx || mz) {
    camera.position.addScaledVector(forward, (mz / len) * speed * dt);
    camera.position.addScaledVector(right, (mx / len) * speed * dt);
    bob += dt * (speed > 6 ? 13 : 9);
  }

  const halfW = layout.maxWidth / 2 - 0.6;
  camera.position.x = Math.max(-halfW, Math.min(halfW, camera.position.x));
  camera.position.z = Math.max(layout.regions.at(-1).zFar + 1.5,
    Math.min(layout.regions[0].zNear + 7, camera.position.z));
  camera.position.y = start.y + (mx || mz ? Math.sin(bob) * 0.022 : 0);

  camera.rotation.set(pitch, yaw, 0);

  const r = regionAt(layout, camera.position.z);
  if (r) {
    $('regionName').textContent = r.name;
    $('regionMeta').textContent = `${r.years[0] === r.years[1] ? r.years[0] : `${r.years[0]}–${r.years[1]}`}　${r.exhibits.length} 件`;
  } else {
    $('regionName').textContent = '走廊';
    $('regionMeta').textContent = `${layout.regions.length} 个展区`;
  }

  lookAtPanel();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

tick();

// 控制台可玩：world.src = "..." 直接改源码；world.upsertPin() 模拟一次拖动
window.world = {
  get ir() { return ir; },
  get layout() { return layout; },
  get src() { return srcText; },
  set src(v) { srcText = v; ta.value = v; recompile(); },
  recompile,
  upsertPin,
  editor: ta,
  camera, scene, renderer, panels,
};
