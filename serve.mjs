// 零依赖静态服务器 + B站封面图代理（CDN 没给 CORS 头，只能服务端转一手）。
// node serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchImage, hostAllowed, createLimiter, ProxyError, DEFAULT_LIMITS as IMG_LIMITS } from './src/imgproxy.mjs';

const root = resolve(process.cwd());

/**
 * 判断目标是否真的在 root 之内。
 * 不能用 target.startsWith(root) —— 字符串前缀不等于路径包含：
 * root=/tmp/worldc 时，/tmp/worldc-secret/x.world 也"以它开头"，但它在根目录外。
 * 用 path.relative 判断，并显式排除 '..' 开头与仍为绝对路径的结果。
 */
function insideRoot(target) {
  const rel = relative(root, target);
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
const port = Number(process.argv[2] || 5173);
const COVER_DIR = join(root, 'cache', 'covers');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// 只代理 B站图片 CDN，避免变成开放代理。
// 具体的白名单、逐跳重定向校验、体积/超时上限都在 src/imgproxy.mjs 里，
// 这里只留一个并发闸门 —— 同时抓 120 张封面时不要把连接池打满。
const imgLimiter = createLimiter(IMG_LIMITS.concurrency);

async function proxyImage(u, res) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('不是合法的图片地址');
    return;
  }
  if (!hostAllowed(parsed.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`不允许的图源：${parsed.hostname}`);
    return;
  }

  const m = u.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const key = createHash('sha1').update(u).digest('hex');
  const file = join(COVER_DIR, `${key}.${ext}`);

  let buf;
  try {
    buf = await readFile(file);
  } catch {
    let held = false;
    try {
      await imgLimiter.acquire();
      held = true;
      buf = (await fetchImage(u)).buf;
    } catch (e) {
      const status = e instanceof ProxyError ? e.status : 502;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`图片代理失败：${e.message}`);
      return;
    } finally {
      if (held) imgLimiter.release();
    }

    await mkdir(COVER_DIR, { recursive: true });
    await writeFile(file, buf);   // 落盘缓存：断网也能再打开
  }

  res.writeHead(200, {
    'Content-Type': MIME['.' + ext] || 'image/jpeg',
    'Cache-Control': 'public, max-age=604800',
  });
  res.end(buf);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p0 = decodeURIComponent(url.pathname);

    if (p0 === '/img') { await proxyImage(url.searchParams.get('u') || '', res); return; }

    // 编辑器保存源码（仅开发用）：只允许写项目内的 .world
    if (p0 === '/api/save') {
      if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const target = resolve(join(root, String(body.path || 'build/scene.world')));
      if (!insideRoot(target) || !target.endsWith('.world')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('只允许写项目内的 .world 文件');
        return;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(body.src ?? ''), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }

    // 根路径默认进星海 —— 那是旗舰体验，也是这个项目最想让人先看到的东西。
    // 走廊后端还在，地址是 /viewer/。
    if (p0 === '/') {
      res.writeHead(302, { Location: '/viewer/space.html' }).end();
      return;
    }

    // 目录跳转必须真的跳到 /viewer/，否则浏览器 base URL 是 /，
    // 页面里的 ./main.js 会解析成 /main.js 而 404（模块加载失败是静默的）。
    if (p0 === '/viewer') {
      res.writeHead(302, { Location: '/viewer/' }).end();
      return;
    }

    let p = p0.endsWith('/') ? p0 + 'index.html' : p0;
    const file = resolve(join(root, p));
    if (!insideRoot(file)) { res.writeHead(403).end('forbidden'); return; }

    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + req.url);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`worldc viewer → http://localhost:${port}/`);
});
