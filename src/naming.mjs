// 命名层：整个架构里唯一"允许有创造性"的一步。
// 结构由确定性规则产生，这里只负责给区域起名字。
//
// 目前两种策略：
//   keyword —— 离线、确定性、无依赖（默认）
//   llm     —— 接大模型，接口留好，没配 key 时自动回退 keyword
//
// 换成 llm 不需要动编译器一行代码 —— 这就是把 AI 权限压到"命名"这一步的好处。

const STOP = new Set([
  '视频', '合集', '一个', '我们', '什么', '怎么', '可以', '这个', '那个', '没有', '就是',
  '真的', '还是', '已经', '自己', '现在', '因为', '所以', '但是', '如果', '他们', '你们',
  '时候', '这样', '然后', '以及', '不是', '不会', '不能', '可能', '感觉', '其实', '或者',
  '而且', '只有', '所有', '非常', '有点', '一点', '还有', '一起', '第一', '第二', '最后',
  '系列', '更新', '推荐', '官方', '完结', '本期', '上集', '下集', '前言',
  '世界', '时光', '故事', '人生', '未来', '过去', '回忆', '希望', '大家', '需要',
  '应该', '继续', '开始', '结束', '全部', '一些', '很多', '地方', '东西', '事情',
]);

function tokens(text) {
  const out = [];
  const han = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of han) {
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    }
  }
  const lat = text.match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
  for (const w of lat) out.push(w.toLowerCase());
  return out;
}

function tally(titles) {
  const m = new Map();
  for (const t of titles) {
    const seen = new Set();
    for (const tok of tokens(t)) {
      if (seen.has(tok)) continue;   // 同一标题里重复不算权重
      seen.add(tok);
      m.set(tok, (m.get(tok) || 0) + 1);
    }
  }
  return m;
}

/**
 * 给一个区域排出候选名字（从好到差）。
 * @param {string[]} titles 本区域的标题
 * @param {string[]} others 其它区域的标题
 */
export function rankNames(titles, others = []) {
  if (!titles.length) return [];

  const mine = tally(titles);
  const rest = tally(others);
  const total = titles.length;
  const minCount = Math.max(2, total * 0.1);

  const cands = [];
  for (const [tok, c] of mine) {
    if (STOP.has(tok)) continue;
    if (c < minCount) continue;
    const other = rest.get(tok) || 0;
    const specificity = c / (1 + other * 1.6);
    const lengthBonus = 1 + 0.3 * (tok.length - 2);   // 长词更具体
    cands.push({ tok, c, score: specificity * lengthBonus });
  }

  // 去掉"被更长的词几乎完全覆盖"的短词：泛式生 < 泛式生贺
  const kept = cands.filter(a => !cands.some(b =>
    b !== a && b.tok.length > a.tok.length && b.tok.includes(a.tok) && b.c >= a.c * 0.8
  ));

  kept.sort((a, b) => b.score - a.score || b.tok.length - a.tok.length || a.tok.localeCompare(b.tok));
  return kept.map(o => o.tok);
}

/** 兼容旧接口 */
export function keywordName(titles, others = []) {
  return rankNames(titles, others)[0] || null;
}

/**
 * 可插拔的 llm 策略。没有实现时回退到 keyword。
 * 注意：模型只能返回名字，不能返回结构 —— 这是整套架构的底线。
 */
export async function llmName(ctx) {
  return keywordName(ctx.titles, ctx.others);
}

/**
 * 给多个区域统一命名：同一批里不出现重名，重名就退到次优候选。
 * @returns {Promise<(string|null)[]>} null 表示没有合适候选，交给调用方兜底
 */
export async function nameRegions(groups, strategy = 'keyword') {
  const all = groups.map(g => g.titles);
  const ranked = [];

  for (let i = 0; i < groups.length; i++) {
    const others = all.filter((_, j) => j !== i).flat();
    const ctx = { titles: all[i], others, hint: groups[i].hint || '' };
    if (strategy === 'llm') {
      const nm = await llmName(ctx);
      ranked.push(nm ? [nm, ...rankNames(all[i], others)] : rankNames(all[i], others));
    } else {
      ranked.push(rankNames(all[i], others));
    }
  }

  const used = new Set();
  return ranked.map(list => {
    for (const cand of list) {
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
    return null;
  });
}
