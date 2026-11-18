// 审计 A-08 / A-09 的回归：网络异常与图片代理的防护。
// 全部离线 —— 用注入的假 fetch，不碰真实网络。跑：node test/robustness.mjs

import { api, fetchFolder } from '../src/adapters/bilibili.mjs';
import { fetchImage, hostAllowed, createLimiter, ProxyError } from '../src/imgproxy.mjs';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ·  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ·  ' + detail : ''}`); }
}

const okRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const errRes = (status) => ({
  ok: false,
  status,
  json: async () => ({}),
});

/** 记录调用次数与退避时长的假 fetch */
function recorder(responses) {
  const calls = [];
  const sleeps = [];
  let i = 0;
  return {
    calls,
    sleeps,
    fetchImpl: async (url, opts) => {
      calls.push(url);
      const r = responses[Math.min(i++, responses.length - 1)];
      // 必须把 opts（含 signal）透传下去，否则「超时」这条根本测不到
      if (typeof r === 'function') return r(url, opts);
      return r;
    },
    sleep: async (ms) => { sleeps.push(ms); },
  };
}

const hangingFetch = () => (url, { signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });

console.log('\n  A-08 · 导入的容错');

// 5xx 两次后成功：应该重试，退避 400 → 800
{
  const rec = recorder([errRes(500), errRes(502), okRes({ code: 0, data: { ok: 1 } })]);
  const data = await api('https://api.bilibili.com/x', {
    fetchImpl: rec.fetchImpl, sleep: rec.sleep, timeoutMs: 1000, tries: 3,
  });
  check('5xx 会重试直到成功', data.ok === 1 && rec.calls.length === 3, `${rec.calls.length} 次请求`);
  check('退避是 400 → 800', rec.sleeps.join(',') === '400,800', rec.sleeps.join(',') || '无');
}

// 4xx 不该重试
{
  const rec = recorder([errRes(400)]);
  let msg = '';
  try {
    await api('https://api.bilibili.com/x', { fetchImpl: rec.fetchImpl, sleep: rec.sleep, tries: 3 });
  } catch (e) { msg = e.message; }
  check('4xx 不重试，直接报错', rec.calls.length === 1 && /HTTP 400/.test(msg), `${rec.calls.length} 次 · ${msg.slice(0, 20)}`);
}

// 超时：三次都挂，最后报超时
{
  const rec = recorder([hangingFetch()]);
  let msg = '';
  const t0 = Date.now();
  try {
    await api('https://api.bilibili.com/x', {
      fetchImpl: rec.fetchImpl, sleep: rec.sleep, timeoutMs: 40, tries: 3,
    });
  } catch (e) { msg = e.message; }
  const ms = Date.now() - t0;
  check('请求超时会中断并重试', rec.calls.length === 3 && /超时/.test(msg), `${rec.calls.length} 次 · ${ms}ms`);
  check('超时不会挂死主流程', ms < 2000, `${ms}ms`);
}

// 业务码：-509 限流可重试，-404 不重试
{
  const rec = recorder([okRes({ code: -509, message: '请求过于频繁' }), okRes({ code: 0, data: { n: 2 } })]);
  const d = await api('https://api.bilibili.com/x', { fetchImpl: rec.fetchImpl, sleep: rec.sleep, tries: 3 });
  check('限流码 -509 会重试', d.n === 2 && rec.calls.length === 2, `${rec.calls.length} 次`);

  const rec2 = recorder([okRes({ code: -404, message: '啥都木有' })]);
  let msg = '';
  try { await api('https://api.bilibili.com/x', { fetchImpl: rec2.fetchImpl, sleep: rec2.sleep, tries: 3 }); }
  catch (e) { msg = e.message; }
  check('业务码 -404 不重试', rec2.calls.length === 1 && /-404/.test(msg), `${rec2.calls.length} 次`);
}

// 翻页上限：必须标 partial，而不是悄悄少了
{
  const media = (i) => ({
    bvid: `BV${i}`, id: i, title: `t${i}`, cover: 'https://i0.hdslb.com/x.jpg',
    pubtime: 1700000000 + i, upper: { name: 'u' },
  });
  let pn = 0;
  const fetchImpl = async (url) => {
    pn++;
    const base = (pn - 1) * 20;
    return okRes({
      code: 0,
      data: {
        info: { title: '大收藏夹', media_count: 999 },
        medias: Array.from({ length: 20 }, (_, k) => media(base + k)),
        has_more: true,
      },
    });
  };
  const r = await fetchFolder(1, { max: 9999, pageCap: 3, fetchImpl, sleep: async () => {} });
  check('撞翻页上限会标 partial', r.partial === true && r.items.length === 60, `${r.items.length} 件 · ${r.note}`);
}

// 撞 --max：也标 partial
{
  const media = (i) => ({
    bvid: `BV${i}`, id: i, title: `t${i}`, cover: 'https://i0.hdslb.com/x.jpg',
    pubtime: 1700000000 + i, upper: { name: 'u' },
  });
  const fetchImpl = async () => okRes({
    code: 0,
    data: {
      info: { title: 'x', media_count: 100 },
      medias: Array.from({ length: 20 }, (_, k) => media(k)),
      has_more: true,
    },
  });
  const r = await fetchFolder(1, { max: 25, fetchImpl, sleep: async () => {} });
  check('撞 --max 会标 partial', r.partial === true && r.items.length === 25, `${r.items.length} 件 · ${r.note}`);
}

// 完整取完：不该误标 partial
{
  const fetchImpl = async () => okRes({
    code: 0,
    data: {
      info: { title: 'x', media_count: 2 },
      medias: [
        { bvid: 'BVa', id: 1, title: 'a', cover: 'https://i0.hdslb.com/a.jpg', pubtime: 1700000000 },
        { bvid: 'BVb', id: 2, title: 'b', cover: 'https://i0.hdslb.com/b.jpg', pubtime: 1700000100 },
      ],
      has_more: false,
    },
  });
  const r = await fetchFolder(1, { max: 240, fetchImpl, sleep: async () => {} });
  check('完整取完不标 partial', r.partial === false && r.items.length === 2, `${r.items.length} 件`);
}

console.log('\n  A-09 · 图片代理');

check('放行 hdslb 子域', hostAllowed('i0.hdslb.com') && hostAllowed('archive.hdslb.com') && hostAllowed('hdslb.com'));
check('拦住伪装域名',
  !hostAllowed('hdslb.com.evil.com') && !hostAllowed('i0.hdslb.com.evil.com') && !hostAllowed('evil.com') && !hostAllowed('127.0.0.1'));

// 重定向到别的域名：必须在发出第二跳之前拦住
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      status: 302,
      ok: false,
      headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://127.0.0.1:8080/secret' : null) },
      body: null,
    };
  };
  let err = null;
  try { await fetchImage('https://i0.hdslb.com/a.jpg', { fetchImpl }); } catch (e) { err = e; }
  check('重定向到非白名单域名被拦',
    err instanceof ProxyError && err.status === 403 && calls.length === 1,
    `${err?.status} · 只发了 ${calls.length} 次请求`);
}

// 重定向次数超限
{
  const fetchImpl = async () => ({
    status: 302, ok: false,
    headers: { get: () => 'https://i0.hdslb.com/loop.jpg' },
    body: null,
  });
  let err = null;
  try { await fetchImage('https://i0.hdslb.com/a.jpg', { fetchImpl, limits: { maxBytes: 1e6, timeoutMs: 2000, maxHops: 2, concurrency: 1 } }); }
  catch (e) { err = e; }
  check('重定向超过上限被拦', err instanceof ProxyError && err.status === 502, `${err?.status} · ${err?.message}`);
}

// 非图片 content-type
{
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: (async function* () { yield Buffer.from('<html>'); })(),
  });
  let err = null;
  try { await fetchImage('https://i0.hdslb.com/a.jpg', { fetchImpl }); } catch (e) { err = e; }
  check('非图片响应被拒', err instanceof ProxyError && err.status === 415, `${err?.status}`);
}

// 体积超限（声明）
{
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (k) => {
      const key = k.toLowerCase();
      if (key === 'content-type') return 'image/jpeg';
      if (key === 'content-length') return '999999999';
      return null;
    } },
    body: (async function* () {})(),
  });
  let err = null;
  try { await fetchImage('https://i0.hdslb.com/a.jpg', { fetchImpl }); } catch (e) { err = e; }
  check('声明体积过大直接拒绝', err instanceof ProxyError && err.status === 413, `${err?.status}`);
}

// 体积超限（边流边数，没有 content-length）
{
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    body: (async function* () {
      for (let i = 0; i < 10; i++) yield Buffer.alloc(1024);
    })(),
  });
  let err = null;
  try {
    await fetchImage('https://i0.hdslb.com/a.jpg', {
      fetchImpl, limits: { maxBytes: 4096, timeoutMs: 2000, maxHops: 2, concurrency: 1 },
    });
  } catch (e) { err = e; }
  check('边下边数也能拦住超大图', err instanceof ProxyError && err.status === 413, `${err?.status}`);
}

// 超时
{
  let err = null;
  try {
    await fetchImage('https://i0.hdslb.com/a.jpg', {
      fetchImpl: hangingFetch(),
      limits: { maxBytes: 1e6, timeoutMs: 50, maxHops: 2, concurrency: 1 },
    });
  } catch (e) { err = e; }
  check('上游超时返回 504', err instanceof ProxyError && err.status === 504, `${err?.status} · ${err?.message}`);
}

// 并发闸门
{
  const limiter = createLimiter(2);
  let peak = 0;
  let now = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const task = async () => {
    await limiter.acquire();
    now++;
    peak = Math.max(peak, now);
    await sleep(30);
    now--;
    limiter.release();
  };
  await Promise.all(Array.from({ length: 6 }, task));
  check('并发不超过上限', peak <= 2, `峰值 ${peak} · 上限 2`);
}

console.log('');
console.log(`  ${pass} 通过 · ${fail} 失败`);
console.log('');

process.exit(fail === 0 ? 0 : 1);
