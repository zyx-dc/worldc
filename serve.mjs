// 零依赖静态服务器 + B站封面图代理（CDN 没给 CORS 头，只能服务端转一手）。
// node serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

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

// 只代理 B站图片 CDN，避免变成开放代理
const ALLOWED_IMG = /^https:\/\/[a-z0-9-]+\.hdslb\.com\//i;

async function proxyImage(u, res) {
  if (!ALLOWED_IMG.test(u)) { res.writeHead(403).end('host not allowed'); return; }

  const m = u.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const key = createHash('sha1').update(u).digest('hex');
  const file = join(COVER_DIR, `${key}.${ext}`);

  let buf;
  try {
    buf = await readFile(file);
  } catch {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
    });
    if (!r.ok) { res.writeHead(502).end('upstream ' + r.status); return; }
    buf = Buffer.from(await r.arrayBuffer());
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

    // 根路径必须真的跳到 /viewer/，否则浏览器 base URL 是 /，
    // 页面里的 ./main.js 会解析成 /main.js 而 404（模块加载失败是静默的）。
    if (p0 === '/' || p0 === '/viewer') {
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
