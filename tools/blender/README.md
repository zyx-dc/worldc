# Blender 建场脚本

`space_scene.py`：读 `build/scene.json` + `cache/covers/`，把 120 件收藏用固定种子随机撒成一片星海，导出 glb、星空贴图、布局 JSON，并可渲一张预览。

已在 **Blender 5.2.3 LTS** 跑通。

## 环境（2026-11-16 核验）

**不需要安装任何 Blender 插件。** 这套管线只依赖 glTF 导出器，它在 Blender 里是内置且默认启用的。

| 项 | 值 |
|---|---|
| Blender | 5.2.3 LTS（build 2026-10-22） |
| glTF 导出 | `io_scene_gltf2` 内置，`bpy.ops.export_scene.gltf` 可用 |
| numpy | 2.3.4（Blender 自带，天空贴图靠它算噪声） |
| 第三方插件 | 无。`%APPDATA%/Blender Foundation/Blender/5.2/scripts/addons` 是空的 |

核验命令（`--factory-startup` 是关键：证明在**不加载任何用户配置**的干净环境下也能工作）：

```bash
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
"$BLENDER" -b --factory-startup --python-expr "
import bpy
print('version', bpy.app.version_string)
print('gltf', hasattr(bpy.ops.export_scene,'gltf'))
print('addons', sorted(a.module for a in bpy.context.preferences.addons))"
```


## 跑

```bash
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"

# 只要资产（秒级）
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json \
  --cache cache/covers \
  --out viewer/assets --no-render

# 再加一张预览（1600×900 / 48 samples ≈ 50 s）
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json --cache cache/covers \
  --out build/space-preview --width 1600 --height 900 --samples 48 --cam entry
```

`--cam hero` 换主画特写机位；`--limit N` 只生成前 N 件，方便调试。

## 产物

| 文件 | 说明 | 实测 |
|---|---|---|
| `viewer/assets/space.glb` | 120 个平面，命名 `frame_<itemId>`，extras 带 item/region/hero，无材质 | 112 KB |
| `viewer/assets/sky.jpg` | 4096×2048 equirect，星云 + 1.6 万星点 | 363 KB |
| `build/space-layout.json` | id → 位置/旋转/尺寸/是否主画 | 52 KB |
| `build/space-preview/preview.png` | Cycles 预览（可选） | 1600×900 / 48s ≈ 50 s |

## 确定性（已验证）

同一份 `scene.json` 连跑两次，产物逐字节一致：

```
4e5316d0…  out/a/space-layout.json
4e5316d0…  out/b/space-layout.json
0cc7c9bb…  out/a/space.glb
0cc7c9bb…  out/b/space.glb
cc16e027…  out/a/sky.jpg
cc16e027…  out/b/sky.jpg
```

> 仓库里的 `sky.jpg` 曾与脚本对不上（早期版本的产物，358 KB）。已用当前脚本重新生成，
> 现在是 `cc16e027…` / 363 KB —— 与方案里写的体积一致。**改了脚本一定要重新生成资产再提交。**

## 参数在哪

全部提到脚本顶部了，调视觉只改这几行：

| 常量 | 当前值 | 作用 |
|---|---|---|
| `ANCHORS` | `(0,16) (-34,38) (34,44) (0,70)` | 四个主画锚点（x, 纵深 y, 高度 z） |
| `HERO_W/H` | 8.0 × 4.5 | 主画尺寸 |
| `FRAME_W/H` | 1.6 × 0.9 | 小画基准尺寸 |
| `SCATTER_X` | 12.0 | 簇内横向半径 |
| `SCATTER_Y_NEAR/FAR` | 2.0 / 18.0 | 簇内纵深（锚点之后） |
| `MIN_DIST` | 2.2 | 拒绝采样的最小水平间距 |
| `SIZE_MIN/MAX` | 0.45 / 1.20 | 小画缩放 |
| `HEIGHT_MIN/MAX` | 3.4 / 12.5 | 小画挂高 |

> **踩过的坑：散点范围不能跟锚点间距一个量级。**
> 最初是 `x ±30`、`y +2..+34`（60×32 一片），而四个锚点只相隔 30–40，
> 结果四簇完全糊成一条横带，看着像「缩略图星云」而不是「几座岛」。
> 收紧到 24×16 后，簇与簇之间才留得出空水。**改锚点位置时，记得同时检查这个比例。**

## Blender 5.2 的坑（踩过的）

1. 合成器不是 `scene.node_tree`，是 `bpy.data.node_groups.new(..., 'CompositorNodeTree')` 挂到 `scene.compositing_node_group`，输出用 `NodeGroupOutput`。
2. Glare 节点没有 `glare_type` 属性，类型/质量/尺寸都是 input socket（`'Fog Glow'`、`'Medium'`、`Size` 0–1）。
3. **不要把体积雾挂到 world**：世界体积在无限远处积分 → 光学厚度无限 → 天空全黑。要雾请用有限大的立方体。
4. equirect 星点用 1px + 3×3 柔化，否则会渲染成方块。
5. `export_materials='NONE'`，否则 120 张封面会被打进 glb。
6. 画框朝向：平面先绕 X 转 90° 立起来，再绕 Z 转 `atan2(dx, -dy)`（法线 -Y 朝相机）。
7. `image.pixels` 是线性缓冲：生成 sRGB 颜色后先转线性再写入，Blender 保存时会再编码。
8. **`img.pixels` 的第一行是图像底部**，不是顶部。写数组时不做翻转就会整张图上下颠倒——
   这个坑会连带影响下面第 9 条（极点遮蔽打到了天底而不是天顶）。
9. **equirect 天顶/天底会出现放射状条纹**：横向的星云噪声在极点收束成一点，被压成扇形。
   只做"结构淡出"不够（试过，条纹还在）；正确做法是**按行收敛到该行的经度均值**，
   因为极点处一个像素代表的立体角极小，正确值本来就是沿经度的平均。
   **两端都要处理**——见第 8 条，`pixels` 的底部优先存储会让只压 `v→0` 的写法打到天底去。
   实测验证方式：用 Blender 载入 jpg，量顶部/底部若干行的横向 `std`，
   收敛后应从 0.04 降到 0.002 量级，而赤道行（v=0.5）保持 0.039。
10. **u=0/1 接缝**：天上会出现一条竖直的硬边，两侧亮度突变。
   光把格点索引取模是不够的——采样位置本身必须平铺：
   `xs = np.arange(W) * (gw / W)` 得到 `[0, gw)`，配 `x0 = floor(xs) % gw`、`x1 = (x0+1) % gw`。
   用 `np.linspace(0, gw-1, W)` 会让最左列落在格点 0、最右列落在格点 gw-1，两者是**不同的值**。
   验证：首列与末列的平均绝对差，应从 0.033 降到与相邻列同量级（0.001）。
   网页端还要 `sky.wrapS = THREE.RepeatWrapping`，否则 MIPMAP 跨边界采样仍会露缝。

## 给网页端的约定

- 节点名 `frame_<itemId>`，id 与 `build/scene.json` 的 `exhibits[].item` 一致。
- glTF 用 `export_yup=True`，到 three.js 就是 Y-up、`-Z` 为纵深。
- glb 里没有材质与贴图，封面由网页端按 id 贴；这样同一份 glb 可以复用到任何收藏夹。
