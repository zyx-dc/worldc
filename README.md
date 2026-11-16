# worldc

把一份收藏夹编译成一个可漫游的世界。

**你的收藏夹不需要一个生成器，它需要一个编译器。**

## 跑一下

```bash
# 1. 把一个真实的 B站收藏夹变成一份 .world 源码
node src/cli.mjs import "https://space.bilibili.com/<mid>/favlist?fid=<fid>"
#    也可以简写：node src/cli.mjs import "<mid> <fid>"

# 2. 编译它
node src/cli.mjs build examples/bilibili-demo.world --out build/scene.json
node src/cli.mjs plan  examples/bilibili-demo.world --out build/plan.svg

# 3. 走进去
node serve.mjs      # 然后打开 http://localhost:5173/

# 其它
node test/determinism.mjs                                    # 验证 7 条架构承诺
node src/cli.mjs diff examples/my-favorites.world examples/my-favorites.tidied.world
```

`import` 会写两个文件：`x.world`（**源码，请手改**）和 `x.items.json`（素材缓存）。
`build` 会自动找同名的 `.items.json`，找不到才退回 mock 数据。

> 仓库里**不含 `*.items.json`**：那里面是第三方内容（标题、封面地址），体积也大。
> 想复现真实数据，自己跑一次 `import` 就行 —— 这也顺便证明了它是可重放的。

打开 viewer 后点一下进入，**WASD 走，鼠标环顾，Shift 快走，R 自动前进**。

录屏用的开关（拼在 URL 后面）：

| 参数 | 作用 |
|---|---|
| `?gate=0` | 直接进入，不显示入场层 |
| `?auto=1` | 自动缓慢前进 |
| `?hud=0` | 隐藏所有界面文字 |
| `?z=-31&x=4` | 指定初始机位，方便摆固定镜头 |
| `?edit=1` | **打开编辑器**：左边改源码，右边世界实时重建 |

漫游里按 `E` 也能直接进入编辑模式，`Esc` 回来。

### 编辑模式能做什么

- 改 `.world` 文本 → 右边立刻重建（语法错了会在状态栏报错，不会崩）
- **直接在 3D 里拖动展板** → 源码里自动写回一条 `pin item:N at x 0 z rot r` → 重新编译

实测一次完整的回路（CDP 驱动真实页面）：

```
改动前  39 行 · 0 条 pin · 5 号展品在 [8.349, 0, -6.731]
拖动后  40 行 · 1 条 pin · pin item:5 at 3.5 0 -2 rot 42
        5 号展品实际位置 → [3.5, 0, -2] · pinned=true · hash 9e7a959f48d7
改文本  hue 210→120 / 285→320 → IR 真的变了 · hash 43bd73c866d1 · 120 件
```

这能成立是因为编译器是**同构的**：`src/hash.mjs` 用纯 JS 实现了 sha256，
Node 和浏览器算出完全一样的 hash（已经和 `node:crypto` 逐位比对过）。
否则“改文本→重建”就只是动画，不是真的编译。

> B站封面图没有 CORS 头，viewer 通过 `serve.mjs` 的 `/img?u=` 代理加载，并落盘到
> `cache/covers/`（约 27MB / 118 张）。**缓存下来之后断网也能打开** —— 这正是 V4 离线版的地基。

## 目录

```
docs/ARCHITECTURE.md     架构设计与取舍
docs/preview-3d.png      3D 后端预览（真实收藏夹）
docs/preview-edit.png    编辑模式预览（源码与 3D 并排）
docs/preview-2d.png      2D 后端预览
spec/world.dsl.md        .world 源文件规范
src/parse.mjs            词法 + 递归下降解析
src/layout.mjs           推导层（纯函数）
src/compile.mjs          编译器：源码 → IR · 内容寻址 · 空间 diff
src/hash.mjs             纯 JS sha256（让编译器在浏览器里也能跑）
src/rng.mjs              确定性随机（全项目禁止 Math.random）
src/naming.mjs           命名层（唯一允许"创造性"的一步，可换 LLM）
src/importer.mjs         items → 可手改的 .world 源码
src/world-layout.mjs     把 IR 里的分区排成时间走廊（两个后端共用）
src/render/plan.mjs      2D 后端：IR → 展陈平面图
src/adapters/bilibili.mjs  L1 摄取：B站公开收藏夹
src/adapters/mock.mjs     离线用的假数据
viewer/                  3D 后端：three.js 第一人称漫游
serve.mjs                静态服务器 + 封面图代理
examples/                几个世界，用来演示 diff 与真实导入
test/determinism.mjs     架构承诺的可执行验证
```

## 实测

```
真实收藏夹 192 件 → 取 120 件 → 39 行 / 0.8 KB 源码
  → 4 个自动命名的展区（泛式生贺 / 呜哇 / live2d / mad）
  → 30.4 KB 场景图（含封面 URL）→ 编译 4.6 ms
同一份 IR → 3D 漫游（three.js）+ 2D 导览图（SVG），数据一行不改
```

## 星海模式（规划中）

第三条后端：**Blender 建场 → glTF → three.js 实时漫游**。120 件收藏按种子随机散在一片静水上，
每个展区一幅主画框，水面做实时平面反射；同一份收藏夹永远同一片星海。

这与上面的「零资产」承诺不冲突：主链路仍然是纯程序；星海模式的 glb 与天空贴图都由脚本生成，
随世界重新生成，仓库里只放一份 demo 产物（glb 112 KB + sky 358 KB）。

- 设计与验收：`docs/space-mode.md`
- 生成脚本：`tools/blender/space_scene.py`
- 预览：`docs/preview-space-entry.jpg`、`docs/preview-space-hero.jpg`

```bash
node src/cli.mjs build examples/bilibili-demo.world --out build/scene.json
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json --cache cache/covers --out viewer/assets --no-render
```

网页端 `viewer/space.html` 尚未实现。

## 四条承诺

1. **写种子，不写坐标** —— 同一份源文件永远编译出同一个世界
2. **推导 + 覆盖** —— 120 件里你只手动整理了 2 件，diff 就只报 2 件
3. **世界是程序不是资产** —— 没有模型文件、没有贴图包，可离线
4. **空间 diff 是一等公民** —— 两个版本之间谁动了、动了多远，可精确计算

详见 `docs/ARCHITECTURE.md`。
