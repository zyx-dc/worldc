# worldc

把一份收藏夹编译成一个可漫游的世界。

**你的收藏夹不需要一个生成器，它需要一个编译器。**

## 跑一下

```bash
# 1. 把一个真实的 B站收藏夹变成一份 .world 源码
node src/cli.mjs import "https://space.bilibili.com/<mid>/favlist?fid=<fid>"
#    也可以简写：node src/cli.mjs import "<mid> <fid>"

# 2. 先校验，再编译
node src/cli.mjs check examples/bilibili-demo.world
node src/cli.mjs build examples/bilibili-demo.world --out build/scene.json
node src/cli.mjs plan  examples/bilibili-demo.world --out build/plan.svg

# 3. 走进去
node serve.mjs      # 然后打开 http://localhost:5173/

# 其它
node test/determinism.mjs                                    # 22 条断言
node test/validate.mjs                                       # 18 条 · 语义校验
node test/robustness.mjs                                     # 19 条 · 网络容错 + 图片代理防护（离线）
node src/cli.mjs diff examples/my-favorites.world examples/my-favorites.tidied.world

# github.com 的 git 端点不通、但 api 还能用时（本机代理常这样）
node tools/push-api.mjs
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
- **直接在 3D 里拖动展板** → 源码里自动写回一条 `pin item:"bv_xxx" at x 0 z rot r` → 重新编译

实测一次完整的回路（CDP 驱动真实页面）：

```
改动前  159 行 · 0 条 pin · 5 号展品在 [4.96, 1.44, -15.48]
挪动后  160 行 · 1 条 pin · pin item:"bv_BV15Z421U7Ah" at 3.5 0 -2 rot 42
        5 号展品实际位置 → [3.5, 0, -2] · pinned=true
改文本  hue 210→120 / 285→320 → IR 真的变了 · 120 件
```

这能成立是因为编译器是**同构的**：`src/hash.mjs` 用纯 JS 实现了 sha256，
Node 和浏览器算出完全一样的 hash（已经和 `node:crypto` 逐位比对过）。
否则“改文本→重建”就只是动画，不是真的编译。

> B站封面图没有 CORS 头，viewer 通过 `serve.mjs` 的 `/img?u=` 代理加载，并落盘到
> `cache/covers/`（约 27MB / 118 张）。**缓存下来之后断网也能打开** —— 这正是 V4 离线版的地基。

## 收藏夹会更新

真实收藏夹是会长大的。所以位置不能是「编译时按下标算出来的」——
那样中间插一条，它后面的每一件都会跟着平移。

`.world` 顶部的 `layout 2` 声明算法版本，区域里的 `place` 行把
「身份 → 格子」写成**数据**：

```world
  layout 2
  region "泛式生贺" {
    hue 210
    layout grid 5 6
    place "bv_BV1bc41147oe" 0 0
    place "bv_BV1aZ421z7nd" 0 1
  }
```

收藏夹涨了，重新导入时加 `--merge`：

```bash
node src/cli.mjs import "https://space.bilibili.com/<mid>/favlist?fid=<fid>" \
  --merge --out examples/my-favorites.world
```

它读旧源码、保留每一条已有 `place`，只给新条目找空格。
实测（真实收藏夹 +3 条，其中一条是 2019 年的老视频、被故意插在数组最前面）：

```
items   123  ·  原地 120 / 新增 3 / 移除 0
diff    moved 0 · rotated 0 · region 0 · gone 0 · added 3
```

**旧展品位移 0.000 m。** 取消收藏的条目会从源码里移除并单独报数，不会静默消失。

> `layout` 缺省是 1：早期文件没有 place 行，仍按「序号落格」编译，结果一字不改。
> 迁到 v2 只需要跑一次 `--merge` —— 它认得 v1 的 `take` 区间，能一比一还原每一格。
> 本仓库的 demo 就是这么迁的，120 件位移 0.000 m、转角 0.0°。

## 网络这层按「会坏」来写

导入收藏夹和贴封面是唯二会碰外部网络的地方，两处都当成会失败来处理。

**导入**（`src/adapters/bilibili.mjs`）

- 每次请求 10s 超时，不会挂死
- 5xx / 429 / 超时 / 风控码（-509 这类）退避重试：400ms → 800ms，最多 3 次
- 4xx 和明确的业务错误（-404 之类）**不重试**，直接报出来 —— 重试只会浪费时间
- 撞 `--max` 或翻页上限时标 `partial`，源码头部会写一行「这不是完整收藏夹」
- **残缺快照禁止合并**：否则没取到的条目会被当成「取消收藏」删掉

**图片代理**（`src/imgproxy.mjs`）

- 只放 `hdslb.com` 及其子域
- 重定向**手动**跟随，每一跳重新验域名 —— `fetch` 默认自动跟随，
  上游只要 302 到内网地址，白名单就形同虚设
- 8 MB / 8 s / 6 并发三个上限，只接受 `image/*`

---

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
src/validate.mjs         编译前校验：语义错、容量、悬空引用（error / warning 两级）
src/hash.mjs             纯 JS sha256（让编译器在浏览器里也能跑）
src/rng.mjs              确定性随机（全项目禁止 Math.random）
src/naming.mjs           命名层（唯一允许"创造性"的一步，可换 LLM）
src/importer.mjs         items → 可手改的 .world 源码
src/world-layout.mjs     把 IR 里的分区排成时间走廊（两个后端共用）
src/render/plan.mjs      2D 后端：IR → 展陈平面图
src/adapters/bilibili.mjs  L1 摄取：B站公开收藏夹
src/adapters/mock.mjs     离线用的假数据
viewer/                  3D 后端：three.js 第一人称漫游
src/imgproxy.mjs         封面代理：域名白名单 + 逐跳校验 + 体积/耗时/并发上限
serve.mjs                静态服务器
examples/                几个世界，用来演示 diff 与真实导入
test/determinism.mjs     架构承诺的可执行验证
test/validate.mjs        语义校验的回归
test/robustness.mjs      网络容错与代理防护的回归（全离线）
tools/push-api.mjs       git 端点不通时，走 REST API 推送
```

## 实测

```
真实收藏夹 192 件 → 取 120 件 → 158 行 / 4.6 KB 源码
  → 4 个自动命名的展区（泛式生贺 / 呜哇 / live2d / mad）
  → 32.1 KB 场景图（含封面 URL）
同一份 IR → 3D 漫游（three.js）+ 2D 导览图（SVG），数据一行不改
```

## 星海模式

第三个后端：**Blender 建场 → glTF → three.js 实时漫游**。120 件收藏按种子随机散在一片静水上，
每个展区一幅主画框，水面做实时平面反射；同一份收藏夹永远同一片星海。

与「零资产」承诺不冲突：主链路仍是纯程序；星海模式的 glb 与天空贴图都由脚本生成，
随世界重新生成，仓库里只放一份 demo 产物（glb 111 KB + sky 344 KB）。

- 设计与验收：`docs/space-mode.md`
- 生成脚本：`tools/blender/space_scene.py`（环境与踩坑见同目录 README）
- 页面：`viewer/space.html`
- 预览：`docs/preview-space.png`、`docs/preview-space-hero.png`

```bash
node src/cli.mjs build examples/bilibili-demo.world --out build/scene.json
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
"$BLENDER" -b -P tools/blender/space_scene.py -- \
  --ir build/scene.json --cache cache/covers --out viewer/assets --no-render
node serve.mjs
# http://localhost:5173/viewer/space.html
```

| 参数 | 作用 |
|---|---|
| `?gate=0` · `?hud=0` | 关入场层 · 关界面（录屏用） |
| `?x= ?y= ?z= ?yaw= ?pitch=` | 指定机位 |
| `?water=0` · `?halo=0` | 关水面 · 关辉光（对照用） |
| `?refl=0.5` | 反射分辨率倍率 |
| `?edit=1` 或 <code>`</code> | 开源码面板；拖动画框会写回一条 pin |

操作：`W A S D` 平移，`Q / E` 升降，拖动鼠标环顾。

> 注意：`Q/E` 升降是调试用的，和 spec §4「无飞行」冲突；要守调性的话
> 可以改成只有 `?fly=1` 时才允许。**pin 在星海模式下直接当世界坐标**（y 取 glb 高度），
> 与旧走廊后端的局部坐标语义不同，两边的 `.world` 不能混用。

## 四条承诺

1. **写种子，不写坐标** —— 同一份源文件永远编译出同一个世界
2. **推导 + 覆盖** —— 120 件里你只手动整理了 2 件，diff 就只报 2 件
3. **世界是程序不是资产** —— 没有模型文件、没有贴图包，可离线
4. **空间 diff 是一等公民** —— 两个版本之间谁动了、动了多远，可精确计算

详见 `docs/ARCHITECTURE.md`。
