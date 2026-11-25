// 星海后端 · M1
// 职责：加载 Blender 建好的场（glb）、按 id 贴真实封面、加上外缘辉光。
// 水面反射留给 M2；这里只保证「能在浏览器里看到同一片海」。

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
// three.js 官方 Water（MIT，examples/jsm/objects/Water.js，r160）
// 平面反射 + 滚动法线贴图 + 太阳高光 + 扭曲。用 ?water=lib 切换过来对比。
import { Water } from './vendor/Water.js';
import { parseWorld } from '../src/parse.mjs';
import { compile } from '../src/compile.mjs';

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

// 光晕/光边只放在这一层：主相机能看到，反射相机看不到。
// 反射通道里画它们纯属浪费 —— 120 个 sprite + 120 条光边，
// 而水面只采到一点点光，根本看不出差别。
const NO_REFLECT = 1;

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
camera.layers.enable(NO_REFLECT);
camera.rotation.order = 'YXZ';
camera.position.set(Number(q.get('x') ?? 0), 3.0, Number(q.get('z') ?? 6));

// ── 星空：烘好的 equirect，直接当背景与环境 ──────────────────
const sky = await new THREE.TextureLoader().loadAsync('./assets/sky.jpg');
sky.mapping = THREE.EquirectangularReflectionMapping;
sky.colorSpace = THREE.SRGBColorSpace;
// 等距圆柱贴图必须横向重复寻址：否则 MIPMAP 在 u=0/1 处跨边界采样，
// 会在天上留一条竖直的亮/暗缝。
sky.wrapS = THREE.RepeatWrapping;
sky.wrapT = THREE.ClampToEdgeWrapping;
scene.background = sky;

// ── IR 元数据：只用来查标题/封面/色相，坐标一律以 glb 为准 ────
const ir = await fetch('../build/scene.json').then(r => {
  if (!r.ok) throw new Error(`读不到 build/scene.json（HTTP ${r.status}），先跑 node src/cli.mjs build ...`);
  return r.json();
});
$('worldName').textContent = ir.world;

// ── 编辑模式数据 ──────────────────────────────────────────
const EDIT = q.get('edit') === '1';
let srcText = '';
let editItems = [];

if (EDIT) {
  editItems = await fetch('../build/scene.items.json').then(r => (r.ok ? r.json() : []));
  srcText = await fetch('../build/scene.world').then(r => (r.ok ? r.text() : ''));
}

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

// 辉光渐变：**环形**，不是中心最亮的光斑。
// 光斑贴在画框背后时，中心会被画框完全挡住，能看见的只有外围尾巴；
// 中心最亮的写法等于把能量全浪费在被遮住的区域 —— 前几版看不出辉光就是这个原因。
// 峰值放在 r=0.5（sprite 取 2 倍尺寸时，画框边缘正好在这一圈），向外淡出。
const HALO = (() => {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,0)');
  grd.addColorStop(0.00, 'rgba(255,255,255,0)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0)');
  grd.addColorStop(0.50, 'rgba(255,255,255,0.50)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.32)');
  grd.addColorStop(0.78, 'rgba(255,255,255,0.13)');
  grd.addColorStop(0.90, 'rgba(255,255,255,0.04)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// 提示用的实心小光点：HALO 是环形、中心透明，做不了"远处一颗星"
const HINT_DOT = (() => {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(210,232,255,.55)');
  grd.addColorStop(0.6, 'rgba(170,205,255,.12)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0)');
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

// 「已经点亮过」记在本地：否则每次进来都要重新发现一遍，很烦。
// 键里带世界名，换个收藏夹重新开始。
const SEEN_KEY = `worldc:seen:${ir.world}`;
function seenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
const seenOnce = seenSet();
const alreadySeen = (item) => seenOnce.has(item);
function markSeen(item) {
  seenOnce.add(item);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenOnce])); } catch { /* 隐私模式下写不进去，无所谓 */ }
}
const freshPanels = [];
const seen = new Set();
const box = new THREE.Box3();
const tmpQ = new THREE.Quaternion();
const normal = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
// 这个面的顶点法线是局部 +Y（POSITION 躺在 XZ 平面），不是 three 默认的 +Z
const PLANE_FRONT = new THREE.Vector3(0, 1, 0);

gltf.scene.traverse((o) => {
  const m = /^frame_(.+)$/.exec(o.name || '');
  if (!m) return;

  const id = m[1];
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
  // 注意这里必须用 PLANE_FRONT（局部 +Y），用 (0,0,1) 会算成世界朝下的法线，
  // sprite 就变成往上偏移，中心全被画框挡住，辉光几乎等于没有。
  // 几何对齐：sprite 取 1.28 倍画框时，画框边缘恰好落在 UV 半径 1/1.28 ≈ 0.78 处，
  // 所以贴图的峰値必须放在 0.80（而不是 0.5）。放 0.5 的话峰值藏在画框背后被遮住，
  // 能看见的只有外围长尾巴 —— 那会看起来像背景渐变，不像光晕。
  const factors = (q.get("halo") === "0") ? [] : (hero ? [[2.0, 1.0]] : [[1.9, 0.5]]);
  normal.copy(PLANE_FRONT).applyQuaternion(mesh.getWorldQuaternion(tmpQ));

  const tint = new THREE.Color().setHSL(info.hue / 360, 0.32, 0.88, THREE.SRGBColorSpace);
  const halos = [];
  for (const [f, opacity] of factors) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: HALO,
      color: tint,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    sp.layers.set(NO_REFLECT);
    sp.position.copy(center).addScaledVector(normal, -0.3);
    sp.scale.set(size.x * f, size.y * f, 1);
    scene.add(sp);
    halos.push(sp);
  }

  // 冷白光边：画框没有边框，靠一条加法亮线把轮廓括出来，否则就是一张贴纸
  const rim = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({
      color: 0xcfe6ff,
      transparent: true,
      opacity: hero ? 0.85 : 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  rim.layers.set(NO_REFLECT);
  mesh.add(rim);   // 作为子节点，自动继承画框的位移/旋转/缩放

  panels.push({
    mesh, id, hero, size,
    center: center.clone(),
    region: info.region,
    halos,
    rim,
    rimBase: hero ? 0.85 : 0.5,
    haloBase: halos.map(h => h.material.opacity),
    basePos: mesh.position.clone(),
    baseQuat: mesh.quaternion.clone(),
    yaw: 0,
    normal: normal.clone(),   // 世界空间的正法线
    facing: 1,                // 相机在正面(>0)还是背面(<0)，每帧更新
    // 新收藏：远处只是一个呼吸的光点，走近才展开成画框
    fresh: !!info.fresh && !alreadySeen(info.item),
    reveal: info.fresh && !alreadySeen(info.item) ? 0 : 1,
    hint: null,
  });
});

// ── 新收藏：远处只有一颗呼吸的光点，走近才展开 ─────────────
// 注意不能真的「什么都不显示」——那就永远找不到了。
// 光点的作用是"这里有个东西，值得走过去看看"。
for (const p of panels) {
  if (!p.fresh) continue;

  p.mesh.material.transparent = true;
  p.mesh.material.opacity = 0;
  if (p.rim) p.rim.material.opacity = 0;

  const hint = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO,                 // 环形，不是实心点 —— 读起来像"还没打开"，不是又一颗星
    color: 0xffc98a,           // 暖金，和蓝色画框、白色星光都区分得开
    transparent: true,
    opacity: 0.62,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  hint.scale.setScalar(2.8);
  hint.position.copy(p.center);
  hint.layers.set(NO_REFLECT);
  scene.add(hint);

  p.hint = hint;
  freshPanels.push(p);
}

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

// ── 水面：实时平面反射（spec 附录 A） ────────────────────────
// 水面有三种模式：
//   默认        three.js 官方 Water（MIT，见 viewer/vendor/Water.js）
//   ?water=own  我们自己写的那套（波纹梯度 + 碎光 + 菲涅尔）
//   ?water=0    关掉
const WATER_MODE = q.get('water');
const WATER_ON = WATER_MODE !== '0';
const WATER_LIB = WATER_ON && WATER_MODE !== 'own';
const REFL_SCALE = Number(q.get('refl') ?? 0.75);  // 0.75 分辨率：倒影清楚得多，代价可接受

const rtSize = new THREE.Vector2();
renderer.getSize(rtSize);

/** 从天空 equirect 的赤道那一行取平均色，用于水面远端雾色 —— 这样水天线不会出现硬接缝 */
function skyHorizonColor(tex) {
  const img = tex.image;
  if (!img) return new THREE.Color(0x16293f);
  try {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 1;
    const g = c.getContext('2d');
    const bandH = Math.max(1, Math.round(img.height * 0.03));
    g.drawImage(img, 0, Math.round(img.height * 0.5 - bandH / 2), img.width, bandH, 0, 0, 128, 1);
    const d = g.getImageData(0, 0, 128, 1).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < 128; i++) { r += d[i * 4]; gg += d[i * 4 + 1]; b += d[i * 4 + 2]; }
    return new THREE.Color().setRGB(r / 128 / 255, gg / 128 / 255, b / 128 / 255, THREE.SRGBColorSpace);
  } catch {
    return new THREE.Color(0x16293f);
  }
}

const reflRT = new THREE.WebGLRenderTarget(
  Math.max(2, Math.floor(rtSize.x * REFL_SCALE)),
  Math.max(2, Math.floor(rtSize.y * REFL_SCALE)),
  { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true }
);
reflRT.texture.colorSpace = THREE.SRGBColorSpace;   // 采样即线性，输出不再重复编码

const waterUniforms = {
  tRefl: { value: reflRT.texture },
  uTexMatrix: { value: new THREE.Matrix4() },
  uDeep: { value: new THREE.Color(0x050b16) },
  uFog: { value: skyHorizonColor(sky) },
  uTime: { value: 0 },
  uBlur: { value: 0.0011 },
  // 月光方向：从远处斜上方打过来，水面上会拉出一条竖直碎光带
  uMoon: { value: new THREE.Vector3(0.10, 0.52, -0.85).normalize() },
  uSpec: { value: Number(q.get('spec') ?? 1.25) },
  uDome: { value: Number(q.get('dome') ?? 0.6) },
  // 顶点位移幅度。我们不是海：画框浮在 2.6m 以上，浪高只要打破地平线的"直"
  uWaveH: { value: Number(q.get('waveh') ?? 0.18) },
};

const water = new THREE.Mesh(
  // 700m 见方、200×200 段：水面 330m 外已经全透明，铺 6000m 没意义，
  // 而且网格太稀的话顶点位移会在地平线露出锯齿
  new THREE.PlaneGeometry(700, 700, 200, 200),
  new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      uniform mat4 uTexMatrix;
      uniform float uTime;
      uniform float uWaveH;
      varying vec4 vProj;
      varying vec3 vWorld;

      // 与片元着色器同一组波。位移和法线必须同源，
      // 否则高光会"浮"在水面上，看着像另一层东西在动。
      float waveHeight(vec2 q, float t) {
        float h = 0.0;
        h += sin(dot(q, vec2(0.62, 0.38)) * 0.30 + t * 0.55) * 0.50;
        h += sin(dot(q, vec2(-0.45, 0.80)) * 0.55 - t * 0.75) * 0.32;
        h += sin(dot(q, vec2(0.90, -0.42)) * 1.35 + t * 1.45) * 0.12;
        return h;
      }

      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);

        // 远处压低位移：地平线附近的网格本来就稀，位移大了会抖成锯齿
        float atten = 1.0 / (1.0 + 0.012 * length(wp.xz - cameraPosition.xz));
        wp.y += waveHeight(wp.xz, uTime) * uWaveH * atten;

        vWorld = wp.xyz;
        vProj = uTexMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D tRefl;
      uniform vec3 uDeep;
      uniform vec3 uFog;
      uniform float uTime;
      uniform float uBlur;
      uniform vec3 uMoon;
      uniform float uSpec;
      uniform float uDome;
      varying vec4 vProj;
      varying vec3 vWorld;

      // 四组行波叠加，返回高度，梯度用 out 带出来。
      // 波向互不平行、频率成倍 —— 否则一眼能看出是几条正弦。
      float waves(vec2 q, float t, out vec2 grad) {
        grad = vec2(0.0);
        float h = 0.0;

        float a1 = dot(q, vec2(0.62, 0.38));
        float p1 = a1 * 0.30 + t * 0.55;
        h += sin(p1) * 0.50;
        grad += vec2(0.62, 0.38) * 0.30 * cos(p1) * 0.50;

        float a2 = dot(q, vec2(-0.45, 0.80));
        float p2 = a2 * 0.55 - t * 0.75;
        h += sin(p2) * 0.32;
        grad += vec2(-0.45, 0.80) * 0.55 * cos(p2) * 0.32;

        float a3 = dot(q, vec2(0.90, -0.42));
        float p3 = a3 * 1.35 + t * 1.45;
        h += sin(p3) * 0.12;
        grad += vec2(0.90, -0.42) * 1.35 * cos(p3) * 0.12;

        return h;
      }

      // 2D 哈希：给每个格子一个稳定的伪随机值（全项目禁用 Math.random，
      // 着色器里也一样 —— 闪光必须能重放）
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 p = vProj.xy / vProj.w;
        vec2 q = vWorld.xz;
        float d = length(q - cameraPosition.xz);

        // 330m 外已经是全透明，没必要再算一遍波和采样
        float alpha = 1.0 - smoothstep(90.0, 330.0, d);
        if (alpha <= 0.002) discard;

        // 远处的波纹在屏幕上更密，先压一压，免得变成摩尔纹
        float atten = 1.0 / (1.0 + 0.05 * d);

        vec2 grad;
        float h = waves(q, uTime, grad);

        // 扰动反射坐标：横向细碎、竖向拉长 —— 倒影才会被"打碎"而不是整块平移
        p += vec2(grad.x * 0.0011 + grad.y * 0.0009, grad.y * 0.0038) * atten;

        // 竖向多次采样，把亮画框摊成竖直光带
        vec3 refl = texture2D(tRefl, clamp(p, vec2(0.001), vec2(0.999))).rgb * 0.5;
        refl += texture2D(tRefl, clamp(p + vec2(0.0, uBlur), vec2(0.001), vec2(0.999))).rgb * 0.25;
        refl += texture2D(tRefl, clamp(p - vec2(0.0, uBlur), vec2(0.001), vec2(0.999))).rgb * 0.25;
        refl *= 0.93;   // 水会吸收，倒影比实物略暗

        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 2.0);

        vec3 col = mix(uDeep, refl, 0.30 + 0.60 * fres);

        // 天穹漫反射：把整个天空当成一个柔光源。
        // 没有这一项的话，俯视时水面就是一片纯黑 —— 波纹的起伏完全看不出来。
        vec3 Hn = normalize(vec3(0.0, 1.0, 0.0) + V);
        float dome = pow(max(dot(normalize(vec3(-grad.x * 0.05 * atten, 1.0, -grad.y * 0.05 * atten)), Hn), 0.0), 3.0) * uDome;
        col += vec3(0.16, 0.26, 0.42) * dome * (0.25 + 0.75 * fres);

        // 波峰微亮：让暗处也能看出水的起伏，而不是一块黑板
        col += uFog * (clamp(h * 0.55 + 0.5, 0.0, 1.0) - 0.5) * 0.10;

        // ── 月光碎光带 ────────────────────────────────────
        // 法线由同一个梯度场给出，所以高光和倒影的扰动是同步的 ——
        // 两者错位的话，一眼就能看出"光和水不是一回事"。
        // 法线也用同一份梯度，并且随距离衰减 —— 不衰减的话，
        // 远处每个像素覆盖好几条波，高光会混叠成规则条纹（看着像地砖）
        vec3 N = normalize(vec3(-grad.x * 0.05 * atten, 1.0, -grad.y * 0.05 * atten));
        vec3 H = normalize(normalize(uMoon) + V);
        float ndh = max(dot(N, H), 0.0);

        // 用「波峰包络」而不是再叠一条正弦来打碎高光：
        // 正弦在屏幕上是规则条纹，一混叠就成了贴花纹的地板；
        // 波峰是平滑但形状不规则的团，碎光才像随机闪。
        float hn = clamp(h * 0.5 + 0.5, 0.0, 1.0);
        float crest = smoothstep(0.52, 0.96, hn);
        float spec = pow(ndh, 60.0) * (0.30 + 1.15 * crest) + pow(ndh, 6.0) * 0.05;
        col += vec3(0.82, 0.90, 1.0) * spec * uSpec * (0.28 + 0.72 * fres);

        // 逆光时浪峰透出来的一点青绿 —— 材料里"透光"那一条，
        // 夜里的版本就是很淡的一层，只在浪尖亮起来
        float back = pow(max(dot(-V, normalize(uMoon)), 0.0), 3.0);
        col += vec3(0.06, 0.20, 0.22) * crest * back * 0.55;

        // ── 水面碎光 ────────────────────────────────────
        // 夜里的水最容易被认出来的特征不是波纹，是散落的细小反光。
        // 用格子哈希挑出极少数格子点亮，并让它们随距离淡出 ——
        // 不淡出的话远处每像素跨好几百个格子，会抖成噪点。
        float near = 1.0 - smoothstep(12.0, 90.0, d);
        vec2 g = q * 1.9;
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        float cell = hash21(id);
        float pick = pow(cell, 40.0);                       // 只有极少数格子发光
        float dotMask = smoothstep(0.30, 0.02, length(f));  // 发光的是格子中心的小点，不是整格
        float blink = 0.55 + 0.45 * sin(uTime * 2.3 + cell * 47.0);
        col += vec3(0.72, 0.86, 1.0) * pick * dotMask * blink * near * 1.1;

        // 远端渐隐为透明，让天空透出来 —— 比硬染色去接缝可靠得多
        col = mix(col, uFog, smoothstep(40.0, 220.0, d) * 0.55);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  })
);
water.rotation.x = -Math.PI / 2;
water.position.y = 0;
water.visible = WATER_ON && !WATER_LIB;
scene.add(water);

// ── 官方 Water（可选）─────────────────────────────────────
// 它自己做平面反射，所以开了它就不用再调 renderReflection()
let libWater = null;
if (WATER_LIB) {
  const normals = new THREE.TextureLoader().load('./assets/waternormals.jpg', (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  libWater = new Water(new THREE.PlaneGeometry(4000, 4000), {
    textureWidth: 1024,
    textureHeight: 1024,
    waterNormals: normals,
    sunDirection: new THREE.Vector3(0.10, 0.52, -0.85).normalize(),
    sunColor: Number(q.get('libsun') ?? 0x5f7fae),
    waterColor: Number(q.get('libcolor') ?? 0x060c18),
    distortionScale: Number(q.get('libdist') ?? 2.8),
    alpha: Number(q.get('libalpha') ?? 0.86),
    fog: false,
  });
  libWater.material.uniforms.size.value = Number(q.get('libsize') ?? 3.2);
  // 掠射角下几乎全是天空倒影，白天没错，夜里就灰得像水泥 —— 整体压暗
  libWater.material.uniforms.uDim.value = Number(q.get('libdim') ?? 0.35);
  libWater.rotation.x = -Math.PI / 2;
  libWater.position.y = 0;
  scene.add(libWater);
}

// 镜像相机
const mirrorCam = new THREE.PerspectiveCamera();
mirrorCam.layers.set(0);   // 只看第 0 层：光晕/光边不参与反射
const N = new THREE.Vector3(0, 1, 0);
const O = new THREE.Vector3(0, 0, 0);
const _p = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();
const _up = new THREE.Vector3();

function updateMirror(camera, water) {
  _p.setFromMatrixPosition(camera.matrixWorld);
  if (_p.y <= 0.05) return false;                 // 相机到了水面以下就没有反射

  mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
  mirrorCam.position.set(_p.x, -_p.y, _p.z);

  _rot.extractRotation(camera.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(_p);
  _target.copy(O).sub(_look).reflect(N).negate().add(O);
  _up.set(0, 1, 0).applyMatrix4(_rot).reflect(N);

  mirrorCam.up.copy(_up);
  mirrorCam.lookAt(_target);
  mirrorCam.updateMatrixWorld();

  const m = waterUniforms.uTexMatrix.value;
  m.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  m.multiply(mirrorCam.projectionMatrix);
  m.multiply(mirrorCam.matrixWorldInverse);
  m.multiply(water.matrixWorld);
  return true;
}

/** 把反射画面渲进 RT（渲染时藏掉水面，避免自己反射自己） */
function renderReflection() {
  if (!WATER_ON) return;
  camera.updateMatrixWorld();
  if (!updateMirror(camera, water)) return;

  water.visible = false;
  renderer.setRenderTarget(reflRT);
  renderer.clear();
  renderer.render(scene, mirrorCam);
  renderer.setRenderTarget(null);
  water.visible = true;
}

// ── 极简操作：拖动环顾 + WASD 平移 + Q/E 升降 ──────────────
let yaw = Number(q.get('yaw') ?? 0), pitch = Number(q.get('pitch') ?? 0), dragging = false, lastX = 0, lastY = 0;
let camY = Number(q.get('y') ?? 3.0);      // 眼高，默认 3.0（spec §4）
const keys = Object.create(null);

const gate = $('gate');
gate.addEventListener('click', () => gate.classList.add('gone'));
if (q.get('gate') === '0') { gate.classList.add('gone'); gate.style.display = 'none'; }
if (q.get('hud') === '0') {
  document.querySelectorAll('.hud').forEach(el => { el.style.display = 'none'; });
  $('vig').style.display = 'none';
}

// 拖动画框（仅编辑模式）
const ndc = new THREE.Vector2();
const pickRay = new THREE.Raycaster();
const dragPlane = new THREE.Plane();
const hitPt = new THREE.Vector3();
let dragPanel = null;

function setNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

function moveHalos(p) {
  normal.copy(PLANE_FRONT).applyQuaternion(p.mesh.getWorldQuaternion(tmpQ));
  for (const h of p.halos) h.position.copy(p.mesh.position).addScaledVector(normal, -0.3);
}

/**
 * 指针捕获必须包起来。
 * 某些浏览器对「非活动指针」的 pointerId 会抛 InvalidStateError（Safari 尤其），
 * 而这个异常会冒到 window.onerror，被当成「渲染失败」——
 * 实际上画面好好的，只是拖拽开始不了。
 */
function capturePointer(e) {
  try {
    renderer.domElement.setPointerCapture(e.pointerId);
  } catch { /* 捕获失败就退化成不捕获，拖拽照旧能用 */ }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (EDIT) {
    setNdc(e);
    pickRay.setFromCamera(ndc, camera);
    const hit = pickRay.intersectObjects(panels.map(p => p.mesh), false)[0];
    if (hit) {
      dragPanel = panels.find(p => p.mesh === hit.object) || null;
      if (dragPanel) {
        // 在画框所在水平面上拖，不是 y=0 —— 画框挂得高，落点才不会飘
        dragPlane.setFromNormalAndCoplanarPoint(UP, dragPanel.mesh.position);
        dragPanel.mesh.userData.dirty = false;
        capturePointer(e);
        return;
      }
    }
  }
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  capturePointer(e);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragPanel) {
    if (dragPanel.mesh.userData.dirty) {
      upsertPin(
        dragPanel.id,
        dragPanel.mesh.position.x,
        dragPanel.mesh.position.z,
        Math.round(THREE.MathUtils.radToDeg(dragPanel.yaw))
      );
    }
    dragPanel = null;
  }
  dragging = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (dragPanel) {
    setNdc(e);
    pickRay.setFromCamera(ndc, camera);
    if (pickRay.ray.intersectPlane(dragPlane, hitPt)) {
      dragPanel.mesh.position.x = Math.max(-90, Math.min(90, hitPt.x));
      dragPanel.mesh.position.z = Math.max(-140, Math.min(40, hitPt.z));
      moveHalos(dragPanel);
      dragPanel.mesh.userData.dirty = true;
    }
    return;
  }
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.003;
  pitch -= (e.clientY - lastY) * 0.003;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
  lastX = e.clientX; lastY = e.clientY;
});

addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'TEXTAREA') return;   // 编辑器里打字不要触发快捷键
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();   // 别让空格滚页面
  if (e.code === 'Backquote') location.href = EDIT ? './?gate=0' : './?edit=1';
  if (e.code === 'KeyF' && nearPanel && !playing) {
    if (nearPanel.facing < 0.10) {
      cardHint.textContent = '绕到正面再播';   // 背面不给你开
    } else {
      openPlayer(nearPanel);
    }
  }
  if (e.code === 'Escape') {
    if (playing) { closePlayer(); return; }
    if (EDIT) location.href = './?gate=0';
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

// ── 编辑：拖动写回 pin ────────────────────────────────────
// 星海模式下 pin 的语义变了：pos[0]/pos[2] 直接是世界坐标（y 仍取 glb 高度），
// 所以写回时不需要任何反变换，也就不会有旧 viewer 那种 centerZ 偏移。
const fmt = n => String(Number(Number(n).toFixed(2)));
const editorEl = $('editor');
const ta = $('src');
const estat = $('estat');

const _yawQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
let compileTimer = null;

function applyPins(nextIr) {
  const pinned = new Map();
  for (const r of nextIr.regions) {
    for (const e of r.exhibits) if (e.pinned) pinned.set(e.item, e);
  }

  for (const p of panels) {
    const e = pinned.get(p.id);
    if (e) {
      p.yaw = THREE.MathUtils.degToRad(e.rot || 0);
      p.mesh.position.set(e.pos[0], p.basePos.y, e.pos[2]);
    } else {
      p.yaw = 0;
      p.mesh.position.copy(p.basePos);
    }
    p.mesh.quaternion.copy(p.baseQuat).premultiply(_yawQ.setFromAxisAngle(UP, p.yaw));

    normal.copy(PLANE_FRONT).applyQuaternion(p.mesh.getWorldQuaternion(tmpQ));
    for (const h of p.halos) h.position.copy(p.mesh.position).addScaledVector(normal, -0.3);
  }
  gltf.scene.updateMatrixWorld(true);
}

function setStatus(text, bad = false) {
  if (!estat) return;
  estat.textContent = text;
  estat.classList.toggle('bad', bad);
}

function recompile() {
  const t0 = performance.now();
  try {
    const w = parseWorld(srcText);
    const { ir: next, hash, stats } = compile(w, editItems);
    applyPins(next);
    setStatus(`${hash.slice(0, 12)} · ${stats.pinned} 个 pin · ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    setStatus(e.message, true);   // 语法错了只报错，世界保持上一个可用状态
  }
}

function scheduleCompile(delay = 200) {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(recompile, delay);
}

function upsertPin(itemId, x, z, rotDeg) {
  // key 是字符串（bv_xxx），写进 DSL 要带引号；纯数字则为旧格式
  const ref = /^\d+$/.test(String(itemId)) ? String(itemId) : `"${itemId}"`;
  const line = `  pin item:${ref} at ${fmt(x)} 0 ${fmt(z)} rot ${rotDeg}`;
  const re = new RegExp(`^[ \\t]*pin item:${itemId}\\b.*$`, 'm');
  if (re.test(srcText)) srcText = srcText.replace(re, line);
  else srcText = srcText.replace(/(\n)\s*\}\s*$/, `$1${line}\n}\n`);
  if (ta) ta.value = srcText;
  scheduleCompile(0);
}

async function saveSource() {
  try {
    const r = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'build/scene.world', src: srcText }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setStatus('已保存到 build/scene.world');
  } catch (e) {
    setStatus(`保存失败：${e.message}`, true);
  }
}

if (EDIT) {
  if (ta) ta.value = srcText;
  editorEl?.classList.add('on');
  $('hint').style.display = 'none';
  $('gate').style.display = 'none';      // 编辑模式下不要入场遮罩，否则整个画面被压暗
  recompile();
  ta?.addEventListener('input', () => { srcText = ta.value; scheduleCompile(); });
  $('save')?.addEventListener('click', saveSource);
}

// ── 靠近展品：显示信息；按 F 让这块画框真的播起来 ──────────
const NEAR = 16;        // 进入这个距离就显示信息卡
const PLAY_FAR = 34;    // 走远了自动停

const bvidById = new Map();
try {
  const raw = await fetch('../build/scene.items.json').then(r => (r.ok ? r.json() : []));
  for (const it of raw) if (it.bvid) bvidById.set(it.key ?? it.id, it.bvid);
} catch { /* 没有 items.json 就只是不能播 */ }

const cardEl = $('card');
const cardTitle = $('cardTitle');
const cardMeta = $('cardMeta');
const cardHint = $('cardHint');
const playerEl = $('player');
const pvEl = $('pv');

let nearPanel = null;
let playing = null;
let hoverT = 0;
const _corner = new THREE.Vector3();

const _glowN = new THREE.Vector3();
const _glowQ = new THREE.Quaternion();
const _glowV = new THREE.Vector3();

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 光晕和光边必须随「距离」和「朝向」衰减。
 * 不衰减会有两个很显眼的 bug：
 *   1. 贴到画框前：sprite 永远正对相机，尺寸又是世界坐标固定的，
 *      于是铺满整屏，变成一圈占满视野的巨大椭圆环；
 *   2. 侧对画框：画框几乎不可见，光晕却还在，看着像凭空浮着一个环。
 */
function updateGlow() {
  for (const p of panels) {
    const d = p.mesh.position.distanceTo(camera.position);
    let fade = smoothstep(2.5, 9, d);          // 2.5m 内关掉，9m 外恢复

    // 朝向要每帧都算，包括贴脸的时候 —— 它决定了"算不算靠近"，
    // 只在远处更新会读到旧值，走到背后也可能被当成正面。
    _glowN.copy(PLANE_FRONT).applyQuaternion(p.mesh.getWorldQuaternion(_glowQ));
    _glowV.copy(camera.position).sub(p.mesh.position).normalize();
    p.normal.copy(_glowN);
    p.facing = _glowN.dot(_glowV);   // >0 正面，<0 背面

    if (fade > 0) {
      // 法线与视线接近垂直 = 正侧着看，画框本身都看不见了，光晕不该还亮着
      fade *= smoothstep(0.10, 0.45, Math.abs(p.facing));
    }

    p.fade = fade;
    const near = p === nearPanel;
    for (let i = 0; i < p.halos.length; i++) {
      p.halos[i].material.opacity = p.haloBase[i] * fade * (near ? 1 + 0.9 * hoverT : 1) * p.reveal;
    }
    if (p.rim) p.rim.material.opacity = p.rimBase * fade * (near ? 1 + 0.6 * hoverT : 1) * p.reveal;
  }
}


function openPlayer(p) {
  const bvid = bvidById.get(p.id);
  if (!bvid) { cardHint.textContent = '这条没有视频号，播不了'; return; }
  playing = p;
  pvEl.src = `https://player.bilibili.com/player.html?bvid=${bvid}&autoplay=1&danmaku=0&high_quality=1`;
  playerEl.classList.add('on');
}

function closePlayer() {
  playing = null;
  playerEl.classList.remove('on');
  pvEl.src = 'about:blank';
}

$('pclose')?.addEventListener('click', closePlayer);

const PLAYER_W = 960;
const PLAYER_H = 540;

// ── 单应变换：把矩形透视映射到任意四边形（CSS matrix3d） ──────
// 这样播放器是真贴在画框那个平面上：会随视角产生透视，
// 而不是一块永远正对屏幕、跟着视线走的浮层。
function _adj(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function _mm(a, b) {
  const c = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      c[i * 3 + j] = s;
    }
  }
  return c;
}
function _mv(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
function _basis(x1, y1, x2, y2, x3, y3, x4, y4) {
  const m = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
  const v = _mv(_adj(m), [x4, y4, 1]);
  return _mm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
function homography(s, d) {
  return _mm(
    _basis(d[0][0], d[0][1], d[1][0], d[1][1], d[2][0], d[2][1], d[3][0], d[3][1]),
    _adj(_basis(s[0][0], s[0][1], s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]))
  );
}

const _wpos = new THREE.Vector3();
const _proj = new THREE.Vector3();

/** 把播放器贴到画框平面上；看到背面或完全出屏就藏起来 */
function layoutPlayer() {
  if (!playing) return;
  const mesh = playing.mesh;

  normal.copy(PLANE_FRONT).applyQuaternion(mesh.getWorldQuaternion(tmpQ));
  _wpos.copy(camera.position).sub(mesh.position);
  if (normal.dot(_wpos) <= 0.05) { playerEl.style.display = 'none'; return; }   // 背面

  const pts = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    _proj.set(x, 0, z).applyMatrix4(mesh.matrixWorld).project(camera);
    pts.push([(_proj.x * 0.5 + 0.5) * innerWidth, (-_proj.y * 0.5 + 0.5) * innerHeight]);
  }

  // 按屏幕位置定角点顺序，对镜像/翻转都稳
  const pick = (f, max) => pts.reduce((a, b) => ((max ? f(b) > f(a) : f(b) < f(a)) ? b : a));
  const TL = pick(p => p[0] + p[1], false);
  const BR = pick(p => p[0] + p[1], true);
  const TR = pick(p => p[0] - p[1], true);
  const BL = pick(p => p[0] - p[1], false);

  // 完全出屏就藏 —— 不再夹进视口，否则就变成跟着视线走
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  if (Math.max(...xs) < 0 || Math.min(...xs) > innerWidth ||
      Math.max(...ys) < 0 || Math.min(...ys) > innerHeight) {
    playerEl.style.display = 'none';
    return;
  }
  playerEl.style.display = '';

  const S = [[0, 0], [PLAYER_W, 0], [0, PLAYER_H], [PLAYER_W, PLAYER_H]];
  const H = homography(S, [TL, TR, BL, BR]);
  const k = 1 / H[8];
  const m = [
    H[0] * k, H[3] * k, 0, H[6] * k,
    H[1] * k, H[4] * k, 0, H[7] * k,
    0, 0, 1, 0,
    H[2] * k, H[5] * k, 0, H[8] * k,
  ];
  playerEl.style.transform = `matrix3d(${m.map(v => +v.toFixed(8)).join(',')})`;
}

const REVEAL_D = 9;        // 走进这个距离开始点亮
const REVEAL_SEC = 1.3;    // 展开用多久

function updateFresh(dt, t) {
  for (let i = freshPanels.length - 1; i >= 0; i--) {
    const p = freshPanels[i];
    const d = p.mesh.position.distanceTo(camera.position);

    // 光点呼吸：越近越稳、越亮，远处只是一点若有若无的微光
    if (p.hint) {
      const pulse = 0.52 + 0.22 * Math.sin(t * 1.7 + p.center.x * 0.35);
      p.hint.material.opacity = pulse * (1.0 - 0.35 * Math.min(1, d / 60));
      p.hint.scale.setScalar(2.8 + 0.5 * Math.sin(t * 1.7 + p.center.z * 0.2));
    }

    if (d >= REVEAL_D) continue;

    p.reveal = Math.min(1, p.reveal + dt / REVEAL_SEC);
    const k = p.reveal * p.reveal * (3 - 2 * p.reveal);   // smoothstep
    p.mesh.material.opacity = k;

    if (p.reveal >= 1) {
      p.fresh = false;
      // 展开完恢复不透明：一直开着 transparent 会露馅
      // （后面的画框会从这块画里透出来，而且深度写入也乱了）
      p.mesh.material.transparent = false;
      p.mesh.material.depthWrite = true;
      p.mesh.material.opacity = 1;
      p.mesh.material.needsUpdate = true;
      if (p.hint) {
        scene.remove(p.hint);
        p.hint.material.dispose();
        p.hint = null;
      }
      markSeen(p.id);      // 点亮过就记住，下次不再藏
      freshPanels.splice(i, 1);
    }
  }
}

function updateNear() {
  let best = null, bestD = Infinity;
  for (const p of panels) {
    // 站在背面不算「靠近」：否则卡片会浮出来、F 也能按，
    // 但播放器贴在正面，你只会听见声音看不见画面。
    if (p.facing < 0.10) continue;
    const d = p.mesh.position.distanceTo(camera.position);
    if (d < bestD) { bestD = d; best = p; }
  }

  const next = best && bestD < NEAR ? best : null;
  if (next !== nearPanel) {
    nearPanel = next;
    if (nearPanel) {
      const info = metaById.get(nearPanel.id) || {};
      cardTitle.textContent = info.title || `#${nearPanel.id}`;
      cardMeta.textContent = `${info.region || nearPanel.region || ''} · ${info.year ?? ''}${info.owner ? ' · UP ' + info.owner : ''}`;
      cardHint.innerHTML = bvidById.has(nearPanel.id)
        ? '按 <b>F</b> 在画框上播放'
        : '这条没有视频号';
      cardEl.classList.add('on');
    } else {
      cardEl.classList.remove('on');
    }
  }
  // 新收藏：点亮之前不显示标题，否则"惊喜"在路上就被剧透了
  if (nearPanel && nearPanel.reveal < 0.85) {
    cardTitle.textContent = '？？？';
    cardMeta.textContent = '新收藏 · 再走近一点';
  }

  // 播放时把信息卡收掉，别压在播放器下面
  if (playing) cardEl.classList.remove('on');

  // 靠近的反馈：让那块画框自己亮起来（辉光与光边同时提亮），离开时慢慢还回去
  hoverT += ((nearPanel ? 1 : 0) - hoverT) * 0.12;

  if (playing) {
    if (bestD > PLAY_FAR || playing.facing < 0.10) { closePlayer(); return; }
    layoutPlayer();
  }
}

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

  let my = 0;
  if (keys.KeyE || keys.Space) my += 1;
  if (keys.KeyQ || keys.KeyC) my -= 1;

  if (mx || mz) {
    const len = Math.hypot(mx, mz);
    camera.position.addScaledVector(fwd, (mz / len) * speed * dt);
    camera.position.addScaledVector(right, (mx / len) * speed * dt);
  }
  if (my) camY = Math.max(0.5, Math.min(60, camY + my * speed * dt));

  camera.position.y = camY;
  camera.rotation.set(pitch, yaw, 0);

  if (libWater) {
    libWater.material.uniforms.time.value += dt * 0.30;
  } else {
    waterUniforms.uTime.value += dt;
    renderReflection();
  }

  if ((hudFrame++ & 7) === 0) updateHud();
  updateNear();
  updateFresh(dt, performance.now() / 1000);
  updateGlow();
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
  const left = freshPanels.length;
  $('regionMeta').textContent =
    `${info.year ?? ''}　${panels.length} 件${left ? `　·　${left} 处待点亮` : ''}`;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const s = new THREE.Vector2();
  renderer.getSize(s);
  reflRT.setSize(Math.max(2, Math.floor(s.x * REFL_SCALE)), Math.max(2, Math.floor(s.y * REFL_SCALE)));
});

tick();

window.space = {
  scene, camera, renderer, panels, gltf,
  recompile, applyPins, upsertPin,
  openPlayer, closePlayer,
  get nearPanel() { return nearPanel; },
  get playing() { return playing; },
  get bvidCount() { return bvidById.size; },
  get near() { return nearPanel; },   // 调试用：当前算作「靠近」的那一块
  get src() { return srcText; },
  set src(v) { srcText = v; if (ta) ta.value = v; recompile(); },
  editor: ta,
};
