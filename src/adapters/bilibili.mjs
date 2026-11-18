// L1 摄取：B站公开收藏夹适配器。
// 已验证：公开收藏夹匿名可读，不需要用户交出 cookie / SESSDATA。
//
// 网络这一层按「会坏」来写：
//   - 每次请求都有超时（默认 10s），不会挂死
//   - 超时 / 5xx / 429 / 风控码 → 退避重试（400ms → 800ms），最多 3 次
//   - 4xx 与明确的业务错误 → 不重试，直接报出来
//   - 翻页撞到上限、或撞到 --max，都标 partial —— 截断必须说出来，
//     否则用户以为拿到的是完整收藏夹，而世界会少一截却没人知道

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

const TIMEOUT_MS = 10_000;
const TRIES = 3;
const BACKOFF_MS = 400;
const PAGE_CAP = 30;

/** 不重试的错误（参数错、收藏夹不存在、私密……） */
class Fatal extends Error {
  constructor(msg) { super(msg); this.retryable = false; }
}

/** 这些业务码是「暂时的」，值得再试；其余都不值得 */
const RETRYABLE_BIZ = new Set([-412, -500, -509]);

const retryableStatus = s => s === 408 || s === 429 || s >= 500;

async function once(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers: H, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉一个 B站接口。
 * fetchImpl / sleep 可注入 —— 这样重试与超时都能离线测，不用真联网。
 */
export async function api(url, opt = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    timeoutMs = TIMEOUT_MS,
    tries = TRIES,
  } = opt;

  let last = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await once(url, fetchImpl, timeoutMs);

      if (!r.ok) {
        const msg = `HTTP ${r.status} · ${url}`;
        if (!retryableStatus(r.status)) throw new Fatal(msg);
        throw new Error(msg);
      }

      const j = await r.json();
      if (j.code !== 0) {
        const msg = `B站接口返回 ${j.code}：${j.message}`;
        if (!RETRYABLE_BIZ.has(j.code)) throw new Fatal(msg);
        throw new Error(msg);
      }
      return j.data;
    } catch (e) {
      last = e.name === 'AbortError' ? new Error(`请求超时（${timeoutMs}ms）`) : e;
      if (last.retryable === false) throw last;
      if (attempt === tries - 1) break;
      await sleep(BACKOFF_MS * 2 ** attempt);
    }
  }

  throw new Error(`请求失败（试了 ${tries} 次）：${last ? last.message : '未知错误'}`);
}

/** 从链接或 "mid/fid" 里解析出 mid 与收藏夹 id */
export function parseFavTarget(input) {
  const s = String(input).trim();

  const byQuery = s.match(/[?&](?:fid|media_id)=(\d+)/);
  const bySpace = s.match(/space\.bilibili\.com\/(\d+)/);
  const byML = s.match(/ml(\d+)/);

  if (bySpace && byQuery) return { mid: Number(bySpace[1]), fid: Number(byQuery[1]) };
  if (byML) return { mid: null, fid: Number(byML[1]) };

  const pair = s.match(/^(\d+)[/,\s]+(\d+)$/);
  if (pair) return { mid: Number(pair[1]), fid: Number(pair[2]) };

  throw new Error('看不懂这个收藏夹地址。可以贴 https://space.bilibili.com/<mid>/favlist?fid=<fid>，或直接写 "<mid> <fid>"');
}

/** 列出某个用户的公开收藏夹 */
export async function listFolders(mid, opt = {}) {
  const data = await api(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`, opt);
  return (data?.list || []).map(f => ({
    fid: f.id,
    title: f.title,
    count: f.media_count,
    isDefault: f.id === f.mid,
  }));
}

/**
 * 拉取一个公开收藏夹的内容
 * @returns {{info:{title,count}, items:Array, partial:boolean, note:string}}
 *   partial=true 表示这份 items 不是完整的收藏夹（撞了 --max 或翻页上限）
 */
export async function fetchFolder(fid, { mid = null, max = 240, pageCap = PAGE_CAP, ...opt } = {}) {
  const items = [];
  let info = null;
  let pn = 1;
  let partial = false;
  let note = '';

  for (;;) {
    const q = new URLSearchParams({ media_id: String(fid), pn: String(pn), ps: '20', platform: 'web' });
    if (mid) q.set('mid', String(mid));

    const data = await api(`https://api.bilibili.com/x/v3/fav/resource/list?${q}`, opt);
    if (!data) break;

    if (!info && data.info) info = { title: data.info.title, count: data.info.media_count };

    const batch = data.medias || [];
    if (!batch.length) break;

    for (const m of batch) {
      if (items.length >= max) break;
      // 已失效稿件没有封面，跳过
      if (!m.cover || !m.title) continue;
      const ts = (m.pubtime || 0) * 1000;
      items.push({
        key: `bv_${m.bvid || 'x' + m.id}`,
        title: m.title,
        cover: String(m.cover).replace(/^http:\/\//, 'https://'),
        ts,
        year: ts ? new Date(ts).getFullYear() : 0,
        owner: m.upper?.name || '',
        bvid: m.bvid || '',
        source: `bilibili/${m.id}`,
      });
    }

    if (items.length >= max) {
      partial = !!data.has_more;
      if (partial) note = `只取到 ${max} 件（--max 上限），收藏夹还有更多`;
      break;
    }
    if (!data.has_more) break;

    pn++;
    if (pn > pageCap) {
      partial = true;
      note = `翻到第 ${pageCap} 页就停了（还有更多，避免无限翻页）`;
      break;
    }
  }

  if (!info) info = { title: `收藏夹 ${fid}`, count: items.length };

  // 按发布时间正序：走廊入口 = 最早。身份来自 bvid，排序只影响顺序。
  items.sort((a, b) => a.ts - b.ts);

  return { info, items, partial, note };
}
