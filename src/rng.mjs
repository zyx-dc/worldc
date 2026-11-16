// 确定性随机：整个项目的"可复现"就靠这两个函数。
// 任何地方都不允许出现 Math.random()。

/** FNV-1a 32 位字符串哈希 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：给定 32 位种子，返回一个 [0,1) 的确定性随机序列 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从若干字符串构造一个确定性随机源 */
export function rngFrom(...parts) {
  return mulberry32(hash32(parts.join('\u0001')));
}

/** 保留 3 位小数，避免浮点噪声污染编译结果 */
export function round(n, d = 3) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
