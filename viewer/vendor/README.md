# viewer/vendor

第三方代码，都是 MIT，按原样或最小改动放在这里，不走 npm。

| 文件 | 来源 | 许可 | 改动 |
|---|---|---|---|
| `three.module.js` | [three.js](https://github.com/mrdoob/three.js) r160 | MIT | 无（官方构建产物） |
| `GLTFLoader.js` | three.js r160 `examples/jsm/loaders/` | MIT | 只把 `from 'three'` 改成本地路径 |
| `BufferGeometryUtils.js` | three.js r160 `examples/jsm/utils/` | MIT | 同上 |
| `Water.js` | three.js r160 `examples/jsm/objects/Water.js` | MIT | 见下 |

## Water.js 的本地改动

只加了一个 `uDim`（uniform），在片元着色器最后把输出整体乘上它：

```glsl
vec3 outgoingLight = albedo * uDim;
```

原因：这套水面是按白天海面调的。掠射角下水几乎全是天空倒影，
白天没问题，放到我们夜里那片海就灰得像水泥。官方没有调这个的入口，
所以加一个系数，默认 0.35。

其余逻辑（平面反射、法线贴图滚动、菲涅尔、太阳高光）一行没动。

MIT 许可要求保留版权声明 —— 文件头的 copyright 保留原样即可。
