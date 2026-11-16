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

脚本顶部常量：

- `ANCHORS`：四个主画锚点（Blender 坐标：x, 纵深 y, 高度 z）
- `HERO_W/H`、`FRAME_W/H`：主画与小画尺寸
- 散点范围写在 `layout()` 里：`x ±30`、`y +2..+34`、`z 3.2..15.5`、尺寸 `0.62–1.9×`
- 拒绝采样最小间距 `2.4`

## Blender 5.2 的坑（踩过的）

1. 合成器不是 `scene.node_tree`，是 `bpy.data.node_groups.new(..., 'CompositorNodeTree')` 挂到 `scene.compositing_node_group`，输出用 `NodeGroupOutput`。
2. Glare 节点没有 `glare_type` 属性，类型/质量/尺寸都是 input socket（`'Fog Glow'`、`'Medium'`、`Size` 0–1）。
3. **不要把体积雾挂到 world**：世界体积在无限远处积分 → 光学厚度无限 → 天空全黑。要雾请用有限大的立方体。
4. equirect 星点用 1px + 3×3 柔化，否则会渲染成方块。
5. `export_materials='NONE'`，否则 120 张封面会被打进 glb。
6. 画框朝向：平面先绕 X 转 90° 立起来，再绕 Z 转 `atan2(dx, -dy)`（法线 -Y 朝相机）。
7. `image.pixels` 是线性缓冲：生成 sRGB 颜色后先转线性再写入，Blender 保存时会再编码。

## 给网页端的约定

- 节点名 `frame_<itemId>`，id 与 `build/scene.json` 的 `exhibits[].item` 一致。
- glTF 用 `export_yup=True`，到 three.js 就是 Y-up、`-Z` 为纵深。
- glb 里没有材质与贴图，封面由网页端按 id 贴；这样同一份 glb 可以复用到任何收藏夹。
