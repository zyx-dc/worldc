// A-06 完整 Validator 的回归：能编译过去但结果是错的那些情况。
// 跑：node test/validate.mjs

import { parseWorld } from '../src/parse.mjs';
import { validate } from '../src/validate.mjs';
import { compile } from '../src/compile.mjs';
import { mockItems } from '../src/adapters/mock.mjs';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '  ·  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ·  ' + detail : ''}`); }
}

const items = mockItems(5, 'v');   // mock_0 .. mock_4
const codes = (list) => list.map(x => x.code);

/** 拼一个最小世界；body 是 world 块内的内容 */
const W = (body, head = ['  seed 1']) =>
  ['world "测试" {', ...head, ...body, '}', ''].join('\n');

const run = (body, head) => validate(parseWorld(W(body, head)), items);

// ── 正常 ───────────────────────────────────────────────
{
  const r = run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_0" 0 0',
    '    place "mock_1" 0 1',
    '  }',
  ]);
  check('合法世界：0 错 0 警', r.ok && !r.warnings.length, `${r.errors.length}/${r.warnings.length}`);
}

// ── 世界级 ─────────────────────────────────────────────
check('seed 为负 → 报错', codes(run([], ['  seed -1']).errors).includes('E-SEED'));
check('未知 layout 版本 → 报错',
  codes(run(['  layout 7', '  region "a" { layout grid 1 1 }']).errors).includes('E-LAYOUT'));

{
  const r = run([
    '  region "同名" { layout grid 1 2 }',
    '  region "同名" { layout grid 1 2 }',
  ]);
  check('两个展区同名 → 报错', codes(r.errors).includes('E-REGION-DUP'));
}

// ── 选区 ───────────────────────────────────────────────
check('take 起点大于终点 → 报错',
  codes(run(['  region "a" {', '    take 5..2', '    layout grid 2 3', '  }']).errors).includes('E-TAKE'));

check('take 超出件数 → 只提醒',
  codes(run(['  region "a" {', '    take 0..99', '    layout grid 2 3', '  }']).warnings).includes('W-TAKE'));

check('span 反了 → 报错',
  codes(run(['  region "a" {', '    span 2026..2020', '    layout grid 2 3', '  }']).errors).includes('E-SPAN'));

// ── place ─────────────────────────────────────────────
{
  const r = run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_99" 0 0',
    '  }',
  ]);
  const e = r.errors.find(x => x.code === 'E-PLACE-MISSING');
  check('place 引用不存在的展品 → 报错', !!e);
  check('并且给出「是想写 X 吗」', /是想写 "mock_0"/.test(e?.msg || ''), e?.msg?.slice(-26));
}

check('place 超出 grid → 报错',
  codes(run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_0" 9 9',
    '  }',
  ]).errors).includes('E-PLACE-RANGE'));

{
  const r = run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_0" 0 0',
    '    place "mock_1" 0 0',
    '  }',
  ]);
  check('两件抢同一格 → 报错', codes(r.errors).includes('E-PLACE-COLLIDE'));
}

check('同一件写了两条 place → 报错',
  codes(run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_0" 0 0',
    '    place "mock_0" 0 1',
    '  }',
  ]).errors).includes('E-PLACE-DUP'));

{
  const r = run([
    '  layout 2',
    '  region "a" {',
    '    layout grid 2 3',
    '    place "mock_0" 0 0',
    '  }',
    '  region "b" {',
    '    take 0..0',
    '    layout grid 2 3',
    '  }',
  ]);
  check('同一件出现在两个区 → 报错', codes(r.errors).includes('E-ITEM-DUP'));
}

// ── pin ───────────────────────────────────────────────
{
  const r = run([
    '  region "a" {',
    '    take 0..2',
    '    layout grid 2 3',
    '  }',
    '  pin item:"mock_9" at 1 0 1',
  ]);
  check('pin 引用不存在的展品 → 报错（以前是静默丢弃）', codes(r.errors).includes('E-PIN-MISSING'));

  let threw = '';
  try {
    compile(parseWorld(W([
      '  region "a" {',
      '    take 0..2',
      '    layout grid 2 3',
      '  }',
      '  pin item:"mock_9" at 1 0 1',
    ])), items);
  } catch (e) { threw = e.message; }
  check('compile 也会拦（不靠校验层兜底）', /不存在的展品/.test(threw), threw.slice(0, 26));
}

// ── 容量与元信息 ───────────────────────────────────────
{
  const r = run(['  region "a" {', '    span 1900..1901', '    layout grid 1 1', '  }']);
  check('展区为空 → 提醒', codes(r.warnings).includes('W-EMPTY'), r.warnings.find(x => x.code === 'W-EMPTY')?.msg);
}

{
  const r = run(['  region "a" {', '    take 0..4', '    layout grid 1 2', '  }']);
  check('容量不够 → 提醒（不拦编译）',
    codes(r.warnings).includes('W-CAP') && r.ok, r.warnings.find(w => w.code === 'W-CAP')?.msg);
}

check('件数对不上 → 提醒',
  codes(run(['  region "a" {', '    take 0..2', '    layout grid 2 3', '  }'], ['  seed 1', '  items 999']).warnings).includes('W-COUNT'));

console.log('');
console.log(`  ${pass} 通过 · ${fail} 失败`);
console.log('');

process.exit(fail === 0 ? 0 : 1);
