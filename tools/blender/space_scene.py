# Blender 5.2 headless：把 build/scene.json 散成一片星海，导出 glTF + 渲一张预览。
#
# 用法：
#   blender -b -P space_scene.py -- \
#     --ir ../../build/scene.json \
#     --cache ../../cache/covers \
#     --out ./out \
#     --width 1280 --height 720 --samples 24
#
# 产物：
#   out/space.glb            只含画框（材质不导出，网页端按 item id 贴封面）
#   out/space-layout.json    id → 位置/旋转/尺寸/是否主画
#   out/preview.png          预览渲染
#
# 约定：画框对象名 frame_<itemId>；坐标 Blender Z-up，+Y 为纵深（远离相机）。

import bpy
import json
import math
import os
import random
import sys
import hashlib

# ── 参数 ──────────────────────────────────────────────────
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


IR_PATH = os.path.abspath(arg("--ir", "build/scene.json"))
CACHE = os.path.abspath(arg("--cache", "cache/covers"))
OUT = os.path.abspath(arg("--out", "out"))
W = int(arg("--width", 1280))
H = int(arg("--height", 720))
SAMPLES = int(arg("--samples", 24))
DO_RENDER = "--no-render" not in argv
LIMIT = int(arg("--limit", 0))

os.makedirs(OUT, exist_ok=True)

with open(IR_PATH, "r", encoding="utf-8") as f:
    ir = json.load(f)

world_seed = int(ir.get("seed", 0))
rnd = random.Random(world_seed)

# 四个主画锚点：(x, 纵深 y, 高度 z)——与 01-spec §5.1 对应
ANCHORS = [
    (0.0, 16.0, 4.6),
    (-34.0, 38.0, 4.8),
    (34.0, 44.0, 4.8),
    (0.0, 70.0, 4.6),
]
CAM = (0.0, -10.0, 3.0)
LOOK_AT = (0.0, 44.0, 6.4)
LENS = 20
if arg("--cam", "entry") == "hero":
    CAM = (2.2, 3.0, 2.6)
    LOOK_AT = (0.0, 16.0, 4.5)
    LENS = 30

HERO_W, HERO_H = 8.0, 4.5
FRAME_W, FRAME_H = 1.6, 0.9

# 散点参数（调视觉只改这里）
# 原来 x±30、y+2..+34 是 60×32 一片，四簇完全糊成一条带；
# 收紧到 24×16 之后，簇与簇之间才留得出空水。
SCATTER_X = 12.0                 # 簇内横向半径
SCATTER_Y_NEAR, SCATTER_Y_FAR = 2.0, 18.0   # 簇内纵深（锚点之后）
MIN_DIST = 2.2                   # 拒绝采样的最小水平间距
SIZE_MIN, SIZE_MAX = 0.45, 1.20  # 小画相对基准 1.6×0.9 的缩放
HEIGHT_MIN, HEIGHT_MAX = 3.4, 12.5


# ── 场景清空 ──────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'

for col in list(bpy.data.collections):
    bpy.data.collections.remove(col)

frames_col = bpy.data.collections.new("frames")
scene.collection.children.link(frames_col)


# ── 封面解析：URL → sha1 → cache 文件 ─────────────────────
def cover_path(url):
    if not isinstance(url, str) or not url.startswith("http"):
        return None
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        p = os.path.join(CACHE, h + ext)
        if os.path.exists(p):
            return p
    return None


def cover_image(url):
    p = cover_path(url)
    if not p:
        return None
    try:
        img = bpy.data.images.load(p, check_existing=True)
        if img.size[0] > 512:
            img.scale(512, max(1, int(512 * img.size[1] / img.size[0])))
        return img
    except Exception:
        return None


# ── 布局：固定种子，看起来随机 ────────────────────────────
def layout():
    out = []
    for ri, region in enumerate(ir["regions"]):
        ax, ay, az = ANCHORS[ri % len(ANCHORS)]
        ex = region["exhibits"]

        # 主画：年份最新的一件；同年取 id 最小
        hero = sorted(ex, key=lambda e: (-int(e.get("year") or 0), e["item"]))[0]

        placed = [(ax, ay)]
        out.append({
            "item": hero["item"], "region": region["name"], "hue": region["hue"],
            "x": ax, "y": ay, "z": az, "rot": yaw_to_cam(ax, ay),
            "w": HERO_W, "h": HERO_H, "hero": True, "cover": hero.get("cover"),
            "title": hero.get("title", ""), "year": hero.get("year"),
        })

        for e in ex:
            if e["item"] == hero["item"]:
                continue

            # 在锚点后方随机撒点；拒绝采样保证不互相穿插
            for _ in range(160):
                x = ax + rnd.uniform(-SCATTER_X, SCATTER_X)
                y = ay + rnd.uniform(SCATTER_Y_NEAR, SCATTER_Y_FAR)
                if all((x - px) ** 2 + (y - py) ** 2 > MIN_DIST ** 2 for px, py in placed):
                    break
            placed.append((x, y))

            h = rnd.uniform(HEIGHT_MIN, HEIGHT_MAX)
            s = rnd.uniform(SIZE_MIN, SIZE_MAX)
            out.append({
                "item": e["item"], "region": region["name"], "hue": region["hue"],
                "x": x, "y": y, "z": h, "rot": yaw_to_cam(x, y) + rnd.uniform(-0.09, 0.09),
                "w": FRAME_W * s, "h": FRAME_H * s, "hero": False, "cover": e.get("cover"),
                "title": e.get("title", ""), "year": e.get("year"),
            })
    return out


def yaw_to_cam(x, y):
    """画框法线 -Y 朝相机；返回绕 Z 的角度（弧度）"""
    dx, dy = CAM[0] - x, CAM[1] - y
    return math.atan2(dx, -dy)


items = layout()
if LIMIT:
    items = items[:LIMIT]

# ── 材质 ──────────────────────────────────────────────────
def make_material(entry):
    mat = bpy.data.materials.new(f"m_{entry['item']}")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out.location = (600, 0)
    bsdf.location = (300, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    img = cover_image(entry.get("cover"))
    if img:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.location = (-200, 100)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    else:
        hue = (entry["hue"] % 360) / 360.0
        rgb = hsl_to_rgb(hue, 0.45, 0.35)
        bsdf.inputs["Base Color"].default_value = (*rgb, 1)
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1)

    bsdf.inputs["Emission Strength"].default_value = 3.4 if entry["hero"] else 2.0
    bsdf.inputs["Roughness"].default_value = 0.55
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def hsl_to_rgb(h, s, l):
    import colorsys
    return colorsys.hls_to_rgb(h, l, s)


# ── 画框 ──────────────────────────────────────────────────
for entry in items:
    bpy.ops.mesh.primitive_plane_add(size=2, location=(entry["x"], entry["y"], entry["z"]))
    obj = bpy.context.object
    obj.name = f"frame_{entry['item']}"
    obj.rotation_euler = (math.radians(90), 0.0, entry["rot"])
    obj.scale = (entry["w"] / 2, entry["h"] / 2, 1)

    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    frames_col.objects.link(obj)

    mat = make_material(entry)
    obj.data.materials.append(mat)
    obj["item"] = entry["item"]
    obj["region"] = entry["region"]
    obj["hero"] = entry["hero"]

# ── 水面 ──────────────────────────────────────────────────
bpy.ops.mesh.primitive_plane_add(size=4000, location=(0, 30, 0))
water = bpy.context.object
water.name = "water"
wmat = bpy.data.materials.new("water")
wmat.use_nodes = True
wb = wmat.node_tree.nodes.get("Principled BSDF")
wb.inputs["Base Color"].default_value = (0.008, 0.014, 0.028, 1)
wb.inputs["Metallic"].default_value = 1.0
wb.inputs["Roughness"].default_value = 0.018
water.data.materials.append(wmat)

# 细微波纹：噪声 → 凹凸
nt = wmat.node_tree
noise = nt.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 2.4
noise.inputs["Detail"].default_value = 6
bump = nt.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.09
nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
nt.links.new(bump.outputs["Normal"], wb.inputs["Normal"])


# ── 天空：numpy 生成 equirect（星云 + 星点），同时给网页端复用 ──
def make_sky(path, seed, W=4096, H=2048):
    import numpy as np
    rng = np.random.default_rng(seed)

    def value_noise(gh, gw):
        g = rng.random((gh, gw))
        ys = np.linspace(0, gh - 1, H)
        xs = np.linspace(0, gw - 1, W)
        y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, gh - 1)
        x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, gw - 1)
        fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
        top = g[y0][:, x0] * (1 - fx) + g[y0][:, x1] * fx
        bot = g[y1][:, x0] * (1 - fx) + g[y1][:, x1] * fx
        return top * (1 - fy) + bot * fy

    fbm = (0.55 * value_noise(6, 12) + 0.28 * value_noise(14, 28)
           + 0.12 * value_noise(30, 60) + 0.05 * value_noise(64, 128))

    # 垂直渐变：天顶更黑，地平线略亮
    v = np.linspace(0, 1, H)[:, None]
    zenith = np.array([0.004, 0.007, 0.016])
    horizon = np.array([0.020, 0.050, 0.078])
    base = zenith[None, None, :] * (1 - v[..., None]) + horizon[None, None, :] * v[..., None]
    band = np.exp(-((v - 0.5) / 0.055) ** 2)
    base = base + np.array([0.045, 0.095, 0.130])[None, None, :] * band[..., None]

    mask = np.clip((fbm - 0.38) / 0.62, 0, 1) ** 1.3
    teal = np.array([0.055, 0.170, 0.215])
    indigo = np.array([0.070, 0.090, 0.200])
    mix = np.clip(value_noise(4, 8), 0, 1)[..., None]
    neb = teal[None, None, :] * mix + indigo[None, None, :] * (1 - mix)
    sky = base + neb * mask[..., None] * 2.2

    # 星点
    n = 16000
    ys = rng.integers(0, H, n)
    xs = rng.integers(0, W, n)
    bright = rng.random(n) ** 4.5 * 0.85
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            w = 1.0 if (dy == 0 and dx == 0) else 0.12
            yy = np.clip(ys + dy, 0, H - 1)
            xx = (xs + dx) % W
            sky[yy, xx] += (bright * w)[:, None]

    # 3x3 轻微模糊，软化星点
    k = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float32) / 16.0
    pad = np.pad(sky, ((1, 1), (1, 1), (0, 0)), mode="wrap")
    sky = sum(k[i, j] * pad[i:i + H, j:j + W] for i in range(3) for j in range(3))

    sky = np.clip(sky, 0, 1)
    # sRGB → 线性，Blender 保存时会再编码回 sRGB
    lin = np.where(sky <= 0.04045, sky / 12.92, ((sky + 0.055) / 1.055) ** 2.4)

    img = bpy.data.images.new("sky_src", W, H, alpha=False, float_buffer=True)
    rgba = np.ones((H, W, 4), dtype=np.float32)
    rgba[..., :3] = lin
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'JPEG'
    img.save()
    return path

# ── 世界：深蓝底 + 星云 + 星点 ────────────────────────────
world = bpy.data.worlds.new("nebula")
scene.world = world
world.use_nodes = True
wn = world.node_tree
wn.nodes.clear()

wout = wn.nodes.new("ShaderNodeOutputWorld")
wout.location = (600, 0)
env = wn.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(make_sky(os.path.join(OUT, "sky.jpg"), world_seed))
bg = wn.nodes.new("ShaderNodeBackground")
bg.inputs["Strength"].default_value = 1.0
wn.links.new(env.outputs["Color"], bg.inputs["Color"])
wn.links.new(bg.outputs["Background"], wout.inputs["Surface"])

# 注：world volume 会在无限远处把天空积成黑色，这里不加；要雾就用有限大的立方体体积

# ── 相机 ──────────────────────────────────────────────────
bpy.ops.object.empty_add(location=LOOK_AT)
target = bpy.context.object

bpy.ops.object.camera_add(location=CAM)
cam = bpy.context.object
cam.data.lens = LENS
cam.data.sensor_width = 36
scene.camera = cam

con = cam.constraints.new('TRACK_TO')
con.target = target
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'

# ── 渲染设置 ──────────────────────────────────────────────
scene.render.engine = 'CYCLES'
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.transmission_bounces = 2
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.resolution_percentage = 100
scene.render.use_compositing = True
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = os.path.join(OUT, "preview.png")
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except Exception:
    pass

# 辉光（Blender 5.x 合成器是节点组，不再是 scene.node_tree）
comp = bpy.data.node_groups.new("space_comp", "CompositorNodeTree")
scene.compositing_node_group = comp
comp.interface.new_socket(name="Image", in_out='OUTPUT', socket_type='NodeSocketColor')

rl = comp.nodes.new("CompositorNodeRLayers")
glare = comp.nodes.new("CompositorNodeGlare")
glare.inputs['Type'].default_value = 'Fog Glow'
glare.inputs['Quality'].default_value = 'Medium'
glare.inputs['Threshold'].default_value = 0.7
glare.inputs['Size'].default_value = 0.7
glare.inputs['Strength'].default_value = 1.1
cout = comp.nodes.new("NodeGroupOutput")
comp.links.new(rl.outputs["Image"], glare.inputs["Image"])
comp.links.new(glare.outputs["Image"], cout.inputs["Image"])

# ── 导出 glTF（只导画框，不带材质） ───────────────────────
for o in bpy.context.selected_objects:
    o.select_set(False)
for o in frames_col.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = frames_col.objects[0]

glb_path = os.path.join(OUT, "space.glb")
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format='GLB',
    use_selection=True,
    export_apply=True,
    export_materials='NONE',
    export_extras=True,
    export_yup=True,
)

with open(os.path.join(OUT, "space-layout.json"), "w", encoding="utf-8") as f:
    json.dump({
        "seed": world_seed,
        "camera": {"x": CAM[0], "y": CAM[1], "z": CAM[2]},
        "frames": items,
    }, f, ensure_ascii=False, indent=1)

print(f"[space] frames={len(items)} glb={os.path.getsize(glb_path)/1024:.0f}KB")

if DO_RENDER:
    bpy.ops.render.render(write_still=True)
    print("[space] rendered", scene.render.filepath)
