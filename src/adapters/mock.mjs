// Mock 适配器：不联网也能编译世界。
// 真实使用时换成 adapters/bilibili.mjs，输出结构完全一致。

import { rngFrom } from '../rng.mjs';

const PREFIX = [
  '我终于搞懂了', '花三天做完', '对不起，', '别再推荐了', '凌晨三点我在',
  '这可能是B站最好懂的', '劝退警告：', '被低估的', '我讨厌', '关于',
  '重装系统后第一件事是', '看到第 7 分钟我哭了', '全网最细', '十年了，还在',
];

const NOUN = [
  'CSS 布局', '梯度下降', '赛博朋克 2077', '机械键盘', '线性代数',
  '手冲咖啡', '老式收音机', 'TypeScript 泛型', '猫的行为学', '胶片冲洗',
  '注意力机制', '宫崎骏分镜', '自由泳换气', 'Form 表单校验', '大模型微调',
  '宿舍改造', '公交线路考据', '冷启动优化', '富士山登山', '电子管功放',
];

const OWNER = ['W博士', '老师好我叫何同学', '硬核的半佛', '稚晖君', '一大坨',
  '影视飓风', '罗翔说刑法', '凉风Kaze', '木鱼水心', 'eee'];

/** 时间分段：让 4 个 region 各自有料可放 */
const SEGMENTS = [
  [2015, 2018, 0.30],
  [2019, 2020, 0.25],
  [2021, 2023, 0.25],
  [2024, 2026, 0.20],
];

export function mockItems(n = 120, seed = 'mock-v1') {
  const rnd = rngFrom(String(seed), String(n));
  const items = [];

  let id = 0;
  for (const [y0, y1, weight] of SEGMENTS) {
    const count = Math.round(n * weight);
    for (let k = 0; k < count && id < n; k++) {
      const year = y0 + Math.floor(rnd() * (y1 - y0 + 1));
      const p = PREFIX[Math.floor(rnd() * PREFIX.length)];
      const noun = NOUN[Math.floor(rnd() * NOUN.length)];
      items.push({
        key: `mock_${id}`,
        title: `${p}${noun}`,
        year,
        owner: OWNER[Math.floor(rnd() * OWNER.length)],
        cover: `mock://cover/${id}`,
      });
      id++;
    }
  }

  while (items.length < n) {
    const year = 2015 + Math.floor(rnd() * 12);
    items.push({
      key: `mock_${items.length}`,
      title: `${PREFIX[Math.floor(rnd() * PREFIX.length)]}${NOUN[Math.floor(rnd() * NOUN.length)]}`,
      year,
      owner: OWNER[Math.floor(rnd() * OWNER.length)],
      cover: `mock://cover/${items.length}`,
    });
  }

  return items;
}
