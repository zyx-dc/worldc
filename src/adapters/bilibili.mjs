// L1 摄取：B站公开收藏夹适配器。
// 已验证：公开收藏夹匿名可读，不需要用户交出 cookie / SESSDATA。

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

async function api(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status} · ${url}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`B站接口返回 ${j.code}：${j.message}`);
  return j.data;
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
export async function listFolders(mid) {
  const data = await api(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`);
  return (data?.list || []).map(f => ({
    fid: f.id,
    title: f.title,
    count: f.media_count,
    isDefault: f.id === f.mid,
  }));
}

/**
 * 拉取一个公开收藏夹的内容
 * @returns {{info:{title,count}, items:Array}}
 */
export async function fetchFolder(fid, { mid = null, max = 240 } = {}) {
  const items = [];
  let info = null;
  let pn = 1;

  while (items.length < max) {
    const q = new URLSearchParams({ media_id: String(fid), pn: String(pn), ps: '20', platform: 'web' });
    if (mid) q.set('mid', String(mid));

    const data = await api(`https://api.bilibili.com/x/v3/fav/resource/list?${q}`);
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
        id: items.length,
        title: m.title,
        cover: String(m.cover).replace(/^http:\/\//, 'https://'),
        ts,
        year: ts ? new Date(ts).getFullYear() : 0,
        owner: m.upper?.name || '',
        bvid: m.bvid || '',
        source: `bilibili/${m.id}`,
      });
    }

    if (!data.has_more) break;
    pn++;
    if (pn > 30) break;
  }

  if (!info) info = { title: `收藏夹 ${fid}`, count: items.length };

  // 按发布时间正序：走廊入口 = 最早
  items.sort((a, b) => a.ts - b.ts);
  items.forEach((it, i) => { it.id = i; });

  return { info, items };
}
