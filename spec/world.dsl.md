# .world 源文件规范 v0.1

`.world` 是一份纯文本、可 diff、可版本控制的世界源码。它是整个系统的**唯一真相**。

设计约束（按优先级）：

1. **没有坐标** —— 位置必须由推导产生
2. **行数要少** —— 一个 120 件的收藏夹，源文件应该在 40 行以内
3. **diff 可读** —— 改动要能被人一眼看出
4. **不引用资产** —— 只引用 id，不内嵌图片/模型

---

## 词法

| 元素 | 写法 |
|---|---|
| 注释 | `#` 到行尾 |
| 字符串 | `"..."`，可含中文 |
| 数字 | `120`、`-3.2`、`0x3f9a2c` |
| 标识符 | 字母/数字/中文/`_`/`-`/`/` |
| 范围 | `2015..2018` |
| 标点 | `{` `}` `:` |

---

## 语法

```
world := 'world' STRING '{' (seed | source | items | region | pin)* '}'

seed   := 'seed' NUMBER
source := 'source' STRING
items  := 'items' NUMBER

region := 'region' STRING '{' (span | take | hue | layout)* '}'
span   := 'span' NUMBER '..' NUMBER          # 按年份闭区间选素材
take   := 'take' NUMBER '..' NUMBER          # 按 items 序号闭区间选素材
hue    := 'hue' NUMBER                        # 0-360，决定这个区域的主色
layout := 'layout' 'grid' NUMBER NUMBER       # rows cols，容量 = rows × cols

pin    := 'pin' 'item' ':' NUMBER 'at' NUMBER NUMBER NUMBER ['rot' NUMBER]
```

### span 还是 take？

| | 用在哪 | 特点 |
|---|---|---|
| `span 2019..2021` | 手写的世界 | 语义化，"这段时间的东西" |
| `take 0..29` | `worldc import` 生成的世界 | 精确、区间不重叠，天然按时间排序 |

`import` 一律用 `take`，因为真实收藏夹常有一年内的几百条，按年份切会重叠、互相抢素材。手写时用 `span` 更自然。两者都不写就等于"所有素材"。

---

## 示例

```world
world "我的收藏夹" {
  seed 0x3f9a2c
  source "bilibili/fav/8848102"
  items 120

  region "前端考古" {
    span 2015..2018
    hue 210
    layout grid 6 6
  }

  region "AI 元年" {
    span 2024..2026
    hue 160
    layout grid 4 6
  }

  pin item:42 at -3.2 0 -1.5 rot 30
}
```

---

## 语义

### seed
世界的根种子。**改它等于换一个世界**。同一个 seed + 同一份 items + 同一份规则，永远编译出同一个世界。

### region
一个主题区域。`span` 决定哪些年份的收藏落进来；容量 = `rows × cols`，超出部分会被截断（CLI 会报"溢出"）。

区域里的展品顺序即网格填充顺序（先横后纵），由 `span` 过滤后的 items 顺序决定。

### pin
覆盖层。**只用于用户亲手挪过的展品。**

- 未 pin 的展品：位置完全由推导产生
- 被 pin 的展品：坐标/朝向以 pin 为准，但**仍然参与 diff**（这样"你挪过它"这件事本身是可追踪的）
- 一个 item 只应被 pin 一次，多处 pin 时以后出现的为准

---

## 推导规则（v0.1）

```
for i, item in region.items:
  r = floor(i / cols)
  c = i % cols
  rnd = mulberry32(fnv1a(seed + ":" + region.name + ":" + item.id))

  x = (c - (cols-1)/2) * 2.6 + (rnd()-0.5) * 0.4
  z = (r - (rows-1)/2) * 2.6 + (rnd()-0.5) * 0.4
  rot = (rnd()-0.5) * 8
```

关键点：**每件展品一条独立随机流**。所以新增一件收藏，不会让别的展品挪位置 —— 这是增量编译成立的前提。

---

## 待定（v0.2+）

- `layout shelf N` —— 超过容量时自动分馆，而不是截断
- `anchor` —— 把一个 region 钉在地图上的绝对位置（多世界的空间拼合）
- `theme` —— 材质/光照预设
- `include` —— 世界的组合（我的收藏夹 + 你的收藏夹）
