# worldc 星海模式 · 施工方案（Blender → glTF → 网页）

> 状态：设计与建场脚本已就位；网页端 `viewer/space.html` 待实现。
> 配套：`tools/blender/space_scene.py`、`tools/blender/README.md`
> 环境：Blender **5.2.3 LTS**

---

## 0. 一句话定义

**Blender 负责「建场」：把 120 件收藏随机撒成一片星海，导出 glb 和星空贴图；three.js 负责「活起来」：贴真实封面、做水面实时倒影、拖动编辑。**

几何在 Blender 里定稿，光和水在网页里实时算——这样既有 DCC 的画面质量，又不丢掉漫游。

---

## 1. 参考视频拆解

来源：用户提供的 5 分 31 秒视频（960×544）。目标是后半段的水上纪念馆镜头（约 2:00–5:31），构图见 `docs/preview-space-hero.jpg`。

| 元素    | 观察                           | 取舍                       |
| ----- | ---------------------------- | ------------------------ |
| 水面    | 占画面下半部，近镜面，波纹细碎；亮画在水里拉出竖直光带  | 必做：实时平面反射 + 轻微扰动         |
| 主画框   | 居中偏上，约画面宽 25%，高亮、边缘过曝、周围一圈光晕 | 必做：每区一幅，8 m 宽            |
| 小记忆窗  | 散落四周，大小/远近/高度都不同，亮度低         | 必做，作为 120 件的载体，压暗        |
| 星云/星点 | 深蓝偏青，星点极密，暗部有尘带              | 必做：Blender 烘 equirect 星空 |
| HUD   | 罗盘、遥测、准星                     | 不做（调性「纪念 · 静默」）          |
| 运动    | 极慢横移，几乎不推拉                   | 做：4.2 m/s，自动漂移 1.4 m/s   |

---

## 2. 已确认的口径

| 项   | 结论                                      |
| --- | --------------------------------------- |
| 效果层 | 水面倒影 + 主画框（小窗与星空作为载体和背景保留）              |
| 空间  | 一整片星海，无走廊、无分区墙                          |
| 调性  | 纪念 · 静默                                 |
| 形态  | 新增 `viewer/space.html`，旧 viewer 不动；保留编辑 |
| 工具链 | **Blender 建场 → 导出 glTF → three.js 加载**  |
| 随机  | **固定种子**：看起来随机，同一份收藏夹永远同一片星海            |
| 编辑  | 保留拖动写回；随机只决定默认位置，pin 仍可覆盖               |

### 2.5 预览

| 文件 | 说明 |
|---|---|
| `docs/preview-space-entry.jpg` | 入口视角：120 张真实封面、随机散点、水面倒影（Blender 预览，未调辉光） |
| `docs/preview-space-hero.jpg` | 主画特写：单幅 8 m 画框与光带倒影 |

这两张是**管线验证图**，用来对齐构图与亮度关系；最终以网页实时效果为准，辉光会用 sprite 补强。

---

## 3. 不可违反的约束

1. **编译器零改动**：`parse / compile / layout / hash / rng / world-layout` 行为不变，`build` 的 hash 必须与改前一致。
2. **确定性**：Blender 侧用 `random.Random(ir.seed)`，不用 `random` 全局状态；同一份 `scene.json` 两次生成必须得到同一份 `space-layout.json`。
3. **资产只能是「生成物」**：允许提交 `viewer/assets/space.glb` 与 `viewer/assets/sky.jpg`（由脚本产出），不允许手工建模、下载贴图、引 CDN。
4. **无后处理**：网页端不引 `EffectComposer` / `UnrealBloomPass`；辉光用加法 sprite。
5. **旧后端不动**：`viewer/index.html`、`viewer/main.js` 只允许修 §7 的坐标 bug。
6. **不加音效**、**不做 HUD 罗盘/准星/遥测**、**不做移动端触屏**（README 里删掉「手机上能跑」）。
7. **版本钉死**：脚本按 Blender 5.2 的 API 写（见附录 B），换版本要先跑一遍 `--no-render`。

---

## 4. 视觉规范

| 项       | 值                                                                         |
| ------- | ------------------------------------------------------------------------- |
| 清屏色 / 雾 | `#03060c` / `FogExp2(#071226, 0.0035)`                                    |
| 相机      | fov 55，起点 `(0, 3.0, 12)`，视线 `-Z`，眼高 3.0                                   |
| 步速      | 4.2 m/s；Shift 9 m/s；自动漂移 1.4 m/s                                          |
| 主画      | 8.0 × 4.5，浮在 y≈4.6，朝相机，emission 3.4（Blender）/ 贴图 + 加法辉光（网页）               |
| 小画      | 1.0–3.0 宽（0.62–1.9 倍基准 1.6×0.9），y 3.2–15.5，朝相机 ±5°                        |
| 辉光      | 主画：16×9 @ 0.34 + 28×16 @ 0.12；小画：2.6×1.6 @ 0.16                           |
| 水面      | 6000×6000，中心色 `#050b16`，反射混合 `0.30 + 0.62·fresnel`，波纹 `0.0026/(1+0.045d)` |
| 星空      | `viewer/assets/sky.jpg`，4096×2048 equirect，星云 teal/indigo，星点 1.6 万        |
| 雾       | 网页端 `FogExp2` 0.0035；Blender 端不加 world volume（见附录 B）                      |
| 色调      | 每区 hue 来自 `.world`，只染画框底图与辉光；整体冷蓝，不加暖光                                    |

判据：入口第一屏（1440×810），最近的主画占画面宽 18–25%，四幅主画可见，水面占下半部，主画倒影竖直可辨。

---

## 5. Blender 侧：生成场

脚本：`tools/blender/space_scene.py`（已在本仓库验证，Blender 5.2.3）

### 5.1 命令

```bash
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"

# 只出 glb + 布局，不渲染（秒级）
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json --cache cache/covers --out viewer/assets --no-render

# 出预览图
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json --cache cache/covers --out build/space-preview \
  --width 1600 --height 900 --samples 48 --cam entry
```

### 5.2 数据流

```
build/scene.json ──┐
                   ├─► Blender 脚本 ─► space.glb（120 个平面，无材质）
cache/covers/*.jpg ┘                 ├─► sky.jpg（4096×2048 equirect）
                                     └─► space-layout.json（id → 位置/旋转/尺寸/hero）
```

- 封面解析：`sha1(cover_url)` + 扩展名 → `cache/covers/<hash>.jpg`，与 `serve.mjs` 的缓存键一致。
- 找不到封面就用该区 hue 的程序化色块，占位不报错。

### 5.3 坐标系与命名

- Blender Z-up，`+Y` 为纵深（远离相机）；导出 glTF 时 `export_yup=True`，到 three.js 自动变成 Y-up、`-Z` 为纵深。
- 画框对象名统一 `frame_<itemId>`，并写入 custom properties `item` / `region` / `hero`（`export_extras=True`）。
- 画框是 2×2 的 Plane，`scale = (w/2, h/2, 1)`，绕 X 转 90° 立起来，再绕 Z 转向相机。

### 5.4 随机散点（固定种子）

- 四个锚点（Blender 坐标，`(x, 纵深 y, 高度 z)`）：  
  `(0,16,4.6) / (-34,38,4.8) / (34,44,4.8) / (0,70,4.6)`。
- 每区一件主画 = **该区年份最新**的一件，放在锚点，尺寸 8×4.5。
- 其余 29 件：以锚点为原点，`x ± 30`、`y +2..+34`、`z 3.2..15.5`、尺寸 `0.62–1.9×` 随机；用拒绝采样保证任意两件水平距离 > 2.4；朝向相机 ±5°。
- 所有随机走 `rnd = random.Random(ir.seed)`，顺序固定（先区、后件），换机器结果一致。
- 锚点、范围、间距都写在脚本顶部常量里，调视觉只改常量。

### 5.5 导出

- glTF：`export_format='GLB'`、`use_selection=True`（只选画框）、`export_materials='NONE'`、`export_apply=True`、`export_extras=True`。
- 实测：120 件 → **112 KB**，导出 0.1 s。
- `sky.jpg`：numpy 生成 equirect（渐变 + 4 层 value noise 做星云 + 1.6 万星点 + 3×3 柔化），Blender 保存 JPEG，**363 KB**。
- 渲染：Cycles CPU，1600×900 / 48 samples ≈ 50 s（可作为验收基线）。

---

## 6. 网页侧：让场活起来

### 6.1 加载

- vendor 官方 loader：`viewer/vendor/GLTFLoader.js` 与 `viewer/vendor/BufferGeometryUtils.js`（three r160 examples/jsm，MIT），把 import 路径改成 `./three.module.js`。
- `new GLTFLoader().load('../assets/space.glb')`，遍历节点，按 `frame_<id>` 取 id。
- 每个节点：新建 `MeshBasicMaterial({ map: 占位底图, toneMapped:false })`，加入辉光 sprite；封面通过 `/img?u=` 异步替换（并发 6）。
- `sky.jpg` 作为 `scene.background` 的 equirect（`Texture.mapping = EquirectangularReflectionMapping`，`colorSpace = SRGB`），同时用于水的反射环境。

### 6.2 水面反射

- 自实现镜像相机（附录 A），RT 半分辨率，`rt.texture.colorSpace = SRGBColorSpace`。
- 片元：波纹扰动 → `texture2D` 采样 → fresnel 混合 → 距离雾。
- 水面不参与反射（渲染 RT 时 `water.visible=false`）。

### 6.3 辉光与氛围

- 画框背后挂加法 sprite（`HALO` 径向贴图），主画两层。
- 星点已烘在 sky 里，不需要额外 Points。
- 网页端不需要任何贴图文件，除 `sky.jpg`。

### 6.4 性能预算

| 项         | 预算                                      |
| --------- | --------------------------------------- |
| 画框        | 120，单 mesh（无材质，运行时挂 map）                |
| draw call | ≤ 300（含反射）                              |
| 纹理        | 120 × 512×288×4 ≈ 71 MB，远程封面覆盖后释放占位图    |
| 帧率        | 1440×810 ≥ 50 fps；不足时反射 RT 降到 0.4×，不关反射 |

---

## 7. 编辑：pin 改为世界坐标

### 7.1 语义

随机布局后，位置不再是「IR 网格 × 变换」，因此 pin 的语义必须改：

> **星海模式下，`pinned === true` 的展品，`pos[0]` / `pos[2]` 直接作为世界坐标 x / z，`rot` 作为世界朝向（度）；y 仍取 glb 里的高度。**

不 pin 的展品用 glb 的变换。编译器不用改：它本来就把 `pin.pos` 写进 `exhibits[i].pos`，星海只是把这份 pos 当世界坐标用。

代价：同一份 `.world` 在旧 viewer 里打开时，被 pin 的展品会落在旧语义的位置。可接受，但要写进 README。

### 7.2 拖动

- 拾取：射线与「该画框所在水平面」求交（`y = 画框当前 y`），不是 y=0。
- 写回：`pin item:N at <worldX> 0 <worldZ> rot <worldYawDeg>`，直接是世界坐标，**不需要反变换**，因此也不会重演旧 viewer 的偏移 bug。
- 写回后重编译 + 重新应用变换，不重建 glb。
- 夹取：x ∈ [-60, 60]，z ∈ [-90, 25]（按世界边界，不再是展区局部）。

### 7.3 旧 viewer 的 P0（仍要修）

旧 viewer 的 `upsertPin` 把世界 z 当局部 z，拖动后偏移一个 `centerZ`。修法：写回前减去该展区 `centerZ`；补一条断言「落点世界坐标 = 拖动落点」的回归测试。

### 7.4 编辑器

复用 `viewer/index.html` 的 `#editor` 面板与 `recompile()`；星海侧只重建材质/变换，不重建几何。

---

## 8. 交付物与命令

```
tools/blender/space_scene.py     生成脚本（已就位）
viewer/assets/space.glb          120 个平面（112 KB）
viewer/assets/sky.jpg            4096×2048 星空（363 KB）
viewer/vendor/GLTFLoader.js      官方 loader（r160）
viewer/vendor/BufferGeometryUtils.js
viewer/space.html                新页面
viewer/space.js                  星海后端
test/space-layout.mjs            布局/编辑回归（glb 与 layout 一致性、pin 语义）
docs/preview-space.png           入口截图
docs/preview-space-hero.png      主画截图
README.md                        新增「星海模式」，删掉「手机上能跑」
```

```bash
node src/cli.mjs build examples/bilibili-demo.world --out build/scene.json
"$BLENDER" -b -P tools/blender/space_scene.py -- --ir build/scene.json --cache cache/covers --out viewer/assets --no-render
node serve.mjs
# http://localhost:5173/viewer/space.html
# 录屏：?gate=0&hud=0   ?auto=1   ?z=-6
# 编辑：?edit=1 或按 E
```

---

## 9. 验收标准

| #  | 项       | 判据                                                     |
| -- | ------- | ------------------------------------------------------ |
| 1  | 编译器未受影响 | `node test/determinism.mjs` 7/7；build hash 与改前一致       |
| 2  | 生成确定性   | 连跑两次 Blender，`space-layout.json` 逐字节一致；glb 大小一致        |
| 3  | 资产体积    | `space.glb` ≤ 200 KB，`sky.jpg` ≤ 500 KB                |
| 4  | 120 件齐全 | glb 节点数 = IR 展品数；命名 `frame_<id>` 一一对应                  |
| 5  | 一屏四主画   | 1440×810 入口视角，4 幅主画可见，最近一幅占宽 18–25%                    |
| 6  | 倒影成立    | 主画倒影竖直、有波纹扰动；水面不是「第二份场景」的贴图感                           |
| 7  | 拖动不跳    | 拖动松手后屏幕位置不动；刷新保持（pin = 世界坐标）                           |
| 8  | 性能      | 1440×810 ≥ 50 fps；反射半分辨率                               |
| 9  | 无错误     | 控制台无 error；断网可开（封面回落程序化底图，sky 本地）                      |
| 10 | 旧后端     | `/viewer/` 视觉不变，仅坐标修复                                  |
| 11 | 截图      | `docs/preview-space*.png` 与 `docs/preview-space-*` 并排看，构图上能对上 |

---

## 10. 分期

| 阶段 | 内容                                  | 产出                  |
| -- | ----------------------------------- | ------------------- |
| M0 | 装/验证 Blender 5.2，跑通脚本 `--no-render` | glb + sky + layout  |
| M1 | 网页加载 glb、贴封面、静态相机                   | 能在浏览器里看到同一片海        |
| M2 | 水面反射 + 辉光 + 雾                       | 达到 `docs/preview-space-entry.jpg` 的观感 |
| M3 | 拖拽编辑 + pin 世界坐标 + 旧 viewer P0       | 编辑闭环                |
| M4 | 性能、移动端降级、截图、README                  | 可交付                 |

顺序不能换：先确认 glb 能进浏览器，再谈水和光。

---

## 11. 假设与取舍

1. **小窗保留**：120 件需要载体，压暗缩小当背景层，不算独立特效。
2. **星空用烘好的 equirect**，不在网页里程序化生成：省 GPU、画质更高、也顺便给了 three.js 环境反射。
3. **不做移动端触屏**，README 删掉相关说法。
4. **pin 语义只在星海模式改为世界坐标**，旧 viewer 不变；README 注明。
5. **主画 = 该区年份最新的一件**；未来可在 `.world` 加 `hero item:N` 覆盖。
6. **Blender 只出 glb 与天空**，不出水面网格与灯光：水与光必须在运行时算，否则一动就穿帮。

---

## 附录 A：平面反射参考实现

```js
const mirrorCam = new THREE.PerspectiveCamera();
const texMatrix = new THREE.Matrix4();
const N = new THREE.Vector3(0, 1, 0), O = new THREE.Vector3(0, 0, 0);
const _p = new THREE.Vector3(), _rot = new THREE.Matrix4();
const _look = new THREE.Vector3(), _target = new THREE.Vector3(), _up = new THREE.Vector3();

function updateMirror(camera, water) {
  _p.setFromMatrixPosition(camera.matrixWorld);
  if (_p.y <= 0.05) return false;

  mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
  mirrorCam.position.set(_p.x, -_p.y, _p.z);

  _rot.extractRotation(camera.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(_p);
  _target.copy(O).sub(_look).reflect(N).negate().add(O);
  _up.set(0, 1, 0).applyMatrix4(_rot).reflect(N);

  mirrorCam.up.copy(_up);
  mirrorCam.lookAt(_target);
  mirrorCam.updateMatrixWorld();

  texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  texMatrix.multiply(mirrorCam.projectionMatrix);
  texMatrix.multiply(mirrorCam.matrixWorldInverse);
  texMatrix.multiply(water.matrixWorld);
  return true;
}
```

```glsl
vec2 p = vProj.xy / vProj.w;
p.x += sin(vWorld.z * 0.62 + uTime * 0.85) * amp;
p.y += cos(vWorld.x * 0.47 + uTime * 0.63) * amp;
vec3 refl = texture2D(tRefl, clamp(p, 0.001, 0.999)).rgb;
vec3 V = normalize(cameraPosition - vWorld);
float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 2.0);
vec3 col = mix(uDeep, refl, 0.30 + 0.62 * fres);
col = mix(col, uFog, smoothstep(60.0, 300.0, length(vWorld.xz - cameraPosition.xz)));
```

RT 的 `colorSpace` 设成 sRGB 后，shader 里直接输出采样值，不要再编码一次，否则发白。

---


## 附录 B：Blender 5.2 的坑（都踩过了）

| 坑 | 现象 | 解法 |
|---|---|---|
| 合成器 API | `scene.node_tree` 不存在 | 用 `bpy.data.node_groups.new(..., 'CompositorNodeTree')` + `scene.compositing_node_group`；输出用 `NodeGroupOutput`，并 `interface.new_socket(..., in_out='OUTPUT')` |
| Glare 参数 | 没有 `glare_type` / `quality` 属性 | 改成输入 socket：`inputs['Type']='Fog Glow'`、`inputs['Quality']='Medium'`、`Size` 为 0–1 浮点 |
| world volume | 天空全黑 | world 体积在无限远处积分 → 光学厚度无限；要雾用有限大的立方体，不要挂 world 的 Volume |
| equirect 生成 | 星点成方块 | 分辨率 ≥4096×2048，星点 1px + 3×3 柔化，别用 2×2 splat |
| glTF 导出 | 材质把 120 张封面打进 glb | `export_materials='NONE'`，封面运行时贴 |
| 坐标系 | 画框朝向反了 | 平面先绕 X 转 90°，再绕 Z 转 `atan2(dx, -dy)`（法线 -Y 朝相机） |
| 图像色彩 | 天空发灰/发白 | `image.pixels` 是线性，生成时先 sRGB→线性，保存时 Blender 会再编码 |

---

## 附录 C：仓库里已知的坑

| 坑 | 说明 |
|---|---|
| 引号不闭环 | `importer` 写 `\"`，`tokenize` 不支持转义 → 含英文引号的标题 build 失败 |
| diff 漏旋转 | 只比 pos，不比 rot |
| `plan.svg` 的 hash | 依赖 CLI 注入的 `ir.__hash`，直接调会输出空 |
| `items.json` 缺失 | CLI 静默退回 mock，出现「真区名 + 假封面」，注意 `items 120 (mock)` |
| GLTFLoader | vendor 里没有，要补 r160 版本，且它会 import `BufferGeometryUtils` |
