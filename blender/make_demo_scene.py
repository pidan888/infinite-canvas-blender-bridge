"""生成一个最小的可渲染 .blend，用来验证 render_clay.py 而不依赖用户的工程文件。

刻意做得简单：地面 + 一片方块 + 一个主体 + 一段绕行相机动画。
它的用途是"冒烟测试渲染器"，不是分镜。想看运镜设计见 render_flight_test.py。

用法：
    blender -b -P make_demo_scene.py -- "E:/tmp/demo_clay.blend" 240
"""

import math
import sys
from pathlib import Path

import bpy

argv = sys.argv
args = argv[argv.index("--") + 1:] if "--" in argv else []
out_path = Path(args[0]) if args else Path("demo_clay.blend")
frames = int(args[1]) if len(args) > 1 else 240
if out_path.suffix.lower() != ".blend":
    out_path = out_path.with_suffix(".blend")
out_path.parent.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0))
bpy.context.object.name = "Ground"

for index, (x, y, height) in enumerate(
    [(-9, -6, 5), (-3, -9, 7), (4, -7, 4), (9, -3, 6), (-8, 5, 5), (2, 8, 8), (10, 6, 4)]
):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, height / 2))
    block = bpy.context.object
    block.name = f"Block_{index}"
    block.scale = (3.2, 3.2, height)

bpy.ops.mesh.primitive_cylinder_add(radius=2.2, depth=0.3, location=(0, 0, 0.15))
bpy.context.object.name = "Plinth"

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.6))
body = bpy.context.object
body.name = "Hero_Body"
body.scale = (1.0, 0.7, 2.6)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.75, location=(0, 0, 3.65))
bpy.context.object.name = "Hero_Head"

bpy.ops.object.empty_add(location=(0, 0, 2.0))
look = bpy.context.object
look.name = "LookTarget"

bpy.ops.object.camera_add(location=(14, -14, 8))
cam = bpy.context.object
cam.name = "Camera"
cam.data.lens = 24.0
cam.data.clip_end = 500.0
scene.camera = cam

track = cam.constraints.new("TRACK_TO")
track.target = look
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"

# 绕主体一圈，首尾闭合成可循环的运镜
radius, height = 18.0, 6.0
for frame, degrees in ((1, 0), (frames, 360)):
    angle = math.radians(degrees)
    cam.location = (radius * math.cos(angle), radius * math.sin(angle), height)
    cam.keyframe_insert(data_path="location", frame=frame)


def iter_fcurves(action):
    """Blender 4.4+ 的 Action 是分层的，fcurves 挂在 layer→strip→channelbag 下。"""
    for fcurve in getattr(action, "fcurves", []) or []:
        yield fcurve
    for layer in getattr(action, "layers", []) or []:
        for strip in getattr(layer, "strips", []) or []:
            for bag in getattr(strip, "channelbags", []) or []:
                for fcurve in bag.fcurves:
                    yield fcurve


action = cam.animation_data.action if cam.animation_data else None
if action is not None:
    for fcurve in iter_fcurves(action):
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"

scene.frame_start = 1
scene.frame_end = frames
scene.render.fps = 24
scene.render.resolution_x = 1280
scene.render.resolution_y = 720

bpy.ops.wm.save_as_mainfile(filepath=str(out_path))
print(f"[demo-scene] 已保存 {out_path}  {frames} 帧")
