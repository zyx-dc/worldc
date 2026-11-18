import { writeFileSync } from 'node:fs';
import { mockItems } from '../src/adapters/mock.mjs';
import { buildWorldFromItems } from '../src/importer.mjs';

// 造一份可以入仓的示例：全合成数据，不含任何第三方内容。
// 目的是让陌生人克隆下来直接能 build / 能走，不用先联网导入。
const items = mockItems(24, 'offline-demo');

const { world } = await buildWorldFromItems(items, {
  title: '离线示例',
  source: 'mock/offline-demo',
  seedKey: 'offline-demo|离线示例',
  perRegion: 12,
});

writeFileSync('examples/offline-demo.world', world, 'utf8');
writeFileSync('examples/offline-demo.items.json', JSON.stringify(items), 'utf8');

console.log('world 行数', world.split('\n').length);
console.log('place 条数', world.split('\n').filter(l => l.trim().startsWith('place ')).length);
console.log('items', items.length);
