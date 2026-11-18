// .world 源文件解析器 —— 手写词法 + 递归下降，不引依赖。
// 语法见 spec/world.dsl.md

const T = { STR: 'str', NUM: 'num', IDENT: 'ident', PUNC: 'punc' };

function lineOf(s, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (s[i] === '\n') n++;
  return n;
}

export function tokenize(src) {
  const out = [];
  const s = src.replace(/\r\n/g, '\n');
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }

    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== '"') {
        // 支持 \" \\ \n \r \t —— importer 会写出这些转义，词法器必须能读回来
        if (s[j] === '\\' && j + 1 < s.length) {
          const e = s[j + 1];
          buf += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
          continue;
        }
        buf += s[j]; j++;
      }
      if (j >= s.length) throw new Error(`第 ${lineOf(s, i)} 行：字符串没有闭合`);
      out.push({ t: T.STR, v: buf, line: lineOf(s, i) });
      i = j + 1;
      continue;
    }

    if (ch === '{' || ch === '}' || ch === ':') {
      out.push({ t: T.PUNC, v: ch, line: lineOf(s, i) });
      i++;
      continue;
    }

    if (s.startsWith('..', i)) {
      out.push({ t: T.PUNC, v: '..', line: lineOf(s, i) });
      i += 2;
      continue;
    }

    const isNumStart = /[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(s[i + 1] ?? ''));
    if (isNumStart) {
      let j = i;
      if (s[j] === '-') j++;
      if (s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X')) {
        j += 2;
        while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
      } else {
        while (j < s.length && /[0-9.]/.test(s[j]) && !s.startsWith('..', j)) j++;
      }
      out.push({ t: T.NUM, v: s.slice(i, j), line: lineOf(s, i) });
      i = j;
      continue;
    }

    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_\-\/\u4e00-\u9fa5]/.test(s[j])) j++;
      out.push({ t: T.IDENT, v: s.slice(i, j), line: lineOf(s, i) });
      i = j;
      continue;
    }

    throw new Error(`第 ${lineOf(s, i)} 行：无法识别的字符 "${ch}"`);
  }

  return out;
}

export function parseNum(tok) {
  const raw = String(tok.v);
  if (/^-?0[xX]/.test(raw)) return parseInt(raw.replace(/^-0[xX]/, '-'), 16);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`第 ${tok.line} 行：${raw} 不是合法数字`);
  return n;
}

class Parser {
  constructor(tokens) {
    this.tk = tokens;
    this.i = 0;
  }

  peek(o = 0) { return this.tk[this.i + o]; }
  atEnd() { return this.i >= this.tk.length; }

  next() {
    const t = this.tk[this.i];
    if (!t) throw new Error('源文件意外结束');
    this.i++;
    return t;
  }

  isIdent(name) {
    const t = this.peek();
    return t && t.t === T.IDENT && t.v === name;
  }

  acceptIdent() {
    const t = this.peek();
    if (t && t.t === T.IDENT) { this.i++; return t; }
    return null;
  }

  expectPunc(ch) {
    const t = this.next();
    if (t.t !== T.PUNC || t.v !== ch) {
      throw new Error(`第 ${t.line} 行：期望 "${ch}"，实际是 "${t.v}"`);
    }
    return t;
  }

  expectStr() {
    const t = this.next();
    if (t.t !== T.STR) throw new Error(`第 ${t.line} 行：期望字符串，实际是 "${t.v}"`);
    return t.v;
  }

  expectNum() {
    const t = this.next();
    if (t.t !== T.NUM) throw new Error(`第 ${t.line} 行：期望数字，实际是 "${t.v}"`);
    return parseNum(t);
  }

  parseWorld() {
    const head = this.acceptIdent();
    if (!head || head.v !== 'world') {
      throw new Error(`第 ${head ? head.line : 1} 行：源文件必须以 world "名字" { 开头`);
    }

    const name = this.expectStr();
    this.expectPunc('{');

    const world = {
      name,
      seed: null,
      source: null,
      items: null,
      regions: [],
      pins: [],
    };

    while (!this.atEnd()) {
      const t = this.peek();
      if (t.t === T.PUNC && t.v === '}') { this.i++; break; }

      const kw = this.acceptIdent();
      if (!kw) throw new Error(`第 ${t.line} 行：期望指令，实际是 "${t.v}"`);

      switch (kw.v) {
        case 'seed':
          world.seed = this.expectNum();
          break;
        case 'source':
          world.source = this.expectStr();
          break;
        case 'items':
          world.items = this.expectNum();
          break;
        case 'region':
          world.regions.push(this.parseRegion());
          break;
        case 'pin':
          world.pins.push(this.parsePin());
          break;
        default:
          throw new Error(`第 ${kw.line} 行：未知指令 "${kw.v}"`);
      }
    }

    if (world.seed === null) throw new Error('缺少 seed —— 没有种子就没有可复现的世界');
    return world;
  }

  parseRegion() {
    const name = this.expectStr();
    this.expectPunc('{');

    const region = {
      name,
      span: [0, 9999],
      take: null,
      hue: 200,
      layout: { type: 'grid', rows: 4, cols: 4 },
      capacity: 16,
    };

    while (!this.atEnd()) {
      const t = this.peek();
      if (t.t === T.PUNC && t.v === '}') { this.i++; break; }

      const kw = this.acceptIdent();
      if (!kw) throw new Error(`第 ${t.line} 行：期望 region 内指令`);
      this.keyword = kw.v;

      if (kw.v === 'span') {
        const a = this.expectNum();
        this.expectPunc('..');
        const b = this.expectNum();
        region.span = [a, b];
      } else if (kw.v === 'take') {
        const a = this.expectNum();
        this.expectPunc('..');
        const b = this.expectNum();
        region.take = [a, b];
      } else if (kw.v === 'hue') {
        region.hue = this.expectNum();
      } else if (kw.v === 'layout') {
        const kind = this.acceptIdent();
        if (!kind) throw new Error(`第 ${kw.line} 行：layout 后面要跟布局类型`);
        const a = this.expectNum();
        const b = this.expectNum();
        region.layout = { type: kind.v, rows: a, cols: b };
        region.capacity = a * b;
      } else {
        throw new Error(`第 ${kw.line} 行：region 里不支持 "${kw.v}"`);
      }
    }

    return region;
  }

  parsePin() {
    const what = this.acceptIdent();
    if (!what || what.v !== 'item') {
      throw new Error(`第 ${what ? what.line : 0} 行：pin 后面要跟 item:<id>`);
    }
    this.expectPunc(':');
    // 素材身份由内容派生（bv_BV1bc41147oe 这种）；数字形式只为兼容旧文件
    const item = this.peek().t === T.STR ? this.expectStr() : String(this.expectNum());

    const at = this.acceptIdent();
    if (!at || at.v !== 'at') throw new Error(`第 ${at ? at.line : 0} 行：pin 缺少 at`);

    const x = this.expectNum();
    const y = this.expectNum();
    const z = this.expectNum();

    let rot = 0;
    if (this.isIdent('rot')) {
      this.i++;
      rot = this.expectNum();
    }

    return { item, pos: [x, y, z], rot };
  }
}

/**
 * 把任意字符串编码成 DSL 字符串字面量（含两侧引号）。
 * 与 tokenize 里的解码是一对：importer 只能通过这里写字符串，
 * 否则两边规则会再次分叉（这正是审计 A-07 指出的问题）。
 */
export function quoteString(s) {
  const body = String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${body}"`;
}

export function parseWorld(src) {
  return new Parser(tokenize(src)).parseWorld();
}
