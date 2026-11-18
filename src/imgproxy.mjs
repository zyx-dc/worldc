// 图片代理：B站 CDN 不给 CORS 头，viewer 只能让本地服务器转一手。
//
// 这是整个项目里唯一「由我们主动访问外部地址」的地方，所以按 SSRF 来防：
//
//   1. 只允许 hdslb.com 及其子域。
//   2. 重定向**手动**跟随，每一跳重新验域名。
//      fetch 默认 redirect:'follow'，上游只要 302 到 169.254.169.254，
//      白名单就形同虚设 —— 这是这类代理最常见的一个洞。
//   3. 体积、耗时、并发都有上限：不能让一张图把磁盘或连接池吃干。
//   4. 只接受 image/*，避免被当成任意文件的搬运工。

export const DEFAULT_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 8000,
  maxHops: 3,
  concurrency: 6,
};

export class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 只放 B站图床。注意要看主机名，不能对整条 URL 做正则 —— 路径里藏着域名就骗过去了 */
export function hostAllowed(host) {
  return /(^|\.)hdslb\.com$/i.test(host);
}

/**
 * 并发闸门。名额直接转让给等待者，不要在唤醒后再抢 ——
 * 否则「减少再增加」之间会有窗口，实际并发会超过上限。
 */
export function createLimiter(n) {
  let active = 0;
  const waiting = [];
  return {
    get active() { return active; },
    async acquire() {
      if (active < n) { active++; return; }
      await new Promise(r => waiting.push(r));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

/**
 * 抓一张图。返回 { buf, contentType }。
 * fetchImpl 可注入，测试里用假的就能覆盖重定向、超限、超时。
 */
export async function fetchImage(rawUrl, { fetchImpl = globalThis.fetch, limits = DEFAULT_LIMITS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs);

  try {
    let cur = String(rawUrl);

    for (let hop = 0; hop <= limits.maxHops; hop++) {
      let u;
      try {
        u = new URL(cur);
      } catch {
        throw new ProxyError(400, '不是合法的图片地址');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new ProxyError(400, `不支持的协议：${u.protocol}`);
      }
      // 每一跳都验 —— 第一跳的地址来自查询参数，之后几跳来自上游的 Location
      if (!hostAllowed(u.hostname)) {
        throw new ProxyError(403, `不允许的图源：${u.hostname}`);
      }

      const r = await fetchImpl(cur, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
      });

      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new ProxyError(502, '上游重定向缺少 location');
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (!r.ok) throw new ProxyError(502, `上游 ${r.status}`);

      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) {
        throw new ProxyError(415, `上游返回的不是图片：${ct || '没有 content-type'}`);
      }

      const declared = Number(r.headers.get('content-length') || 0);
      if (declared > limits.maxBytes) {
        throw new ProxyError(413, `图片太大（声明 ${declared} 字节）`);
      }

      if (!r.body) return { buf: Buffer.alloc(0), contentType: ct };

      const chunks = [];
      let total = 0;
      for await (const chunk of r.body) {
        total += chunk.length;
        if (total > limits.maxBytes) {
          ctrl.abort();
          throw new ProxyError(413, `图片超过 ${limits.maxBytes} 字节`);
        }
        chunks.push(chunk);
      }
      return { buf: Buffer.concat(chunks), contentType: ct };
    }

    throw new ProxyError(502, `重定向超过 ${limits.maxHops} 跳`);
  } catch (e) {
    if (e.name === 'AbortError') throw new ProxyError(504, `上游超时（${limits.timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
