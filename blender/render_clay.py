"""Blender 白模渲染器 —— 画布 L2 桥接的 Blender 侧入口。

一次调用完成：校验 → 设参 → 逐帧渲白模 → 编码 H.264 MP4 → 输出机器可读结果。
只出白模，不做任何材质/贴图/风格化，白模的职责是"告诉模型谁在哪、怎么动、镜头怎么走"。

用法（`--` 之后才是本脚本的参数，前面的是 Blender 的）：

    blender -b -P render_clay.py -- --scene "E:/proj/scene.blend" --out "E:/tmp/clay.mp4"

    blender -b -P render_clay.py -- --scene scene.blend --out clay.mp4 \
        --camera Camera --start 1 --end 720 --fps 24 --res 1280x720

只探测不渲染（给健康检查用，1 秒内回答"这台机器能不能渲这个场景"）：

    blender -b -P render_clay.py -- --scene scene.blend --probe

按镜头描述运镜（关键帧由桥接算好，本脚本只负责插进去）：

    blender -b -P render_clay.py -- --scene scene.blend --out clay.mp4 --shot E:/tmp/shot.json

只出 PNG 序列、不编码（要自己控码率时用）：

    blender -b -P render_clay.py -- --scene scene.blend --out clay.mp4 --frames-dir E:/tmp/seq

stdout 约定（桥接按前缀解析，不要改前缀）：

    PROGRESS {"frame":120,"total":720,"percent":16.7,"elapsed":8.4}
    RESULT   {"ok":true,"out":"E:/tmp/clay.mp4","bytes":4807833,"frames":720,...}
    ERROR    {"ok":false,"code":"NO_CAMERA","message":"..."}
    PROBE    {"ok":true,"cameras":["Camera"],...}

退出码：0 成功 / 2 参数或场景错误 / 3 渲染失败 / 4 产物缺失。

Blender 5.x 兼容性由本脚本内部处理，不要在调用方补偿：
  · 输出格式拆成 media_type + file_format 两步设置
  · Workbench 后台渲染的背景必须显式设 background_type=VIEWPORT，否则纯黑
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector

ENGINE_ALIASES = {
    "workbench": "BLENDER_WORKBENCH",
    "eevee": "BLENDER_EEVEE_NEXT",
    "eevee-legacy": "BLENDER_EEVEE",
    "cycles": "CYCLES",
}


def emit(prefix, payload):
    """按前缀输出一行 JSON，桥接侧只认这个格式。"""
    print(f"{prefix} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def die(code, message, exit_code=2, **extra):
    emit("ERROR", {"ok": False, "code": code, "message": message, **extra})
    sys.exit(exit_code)


def parse_args():
    argv = sys.argv
    raw = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser(prog="blender -b -P render_clay.py --", add_help=True)
    parser.add_argument("--scene", default="", help="要渲染的 .blend 路径")
    parser.add_argument("--out", default="", help="输出 mp4 路径")
    parser.add_argument("--camera", default="", help="相机对象名，留空用场景当前相机")
    parser.add_argument("--shot", default="", help="镜头描述 JSON 路径，给了就按它的关键帧运镜")
    parser.add_argument("--start", type=int, default=0, help="起始帧，0 表示用场景设置")
    parser.add_argument("--end", type=int, default=0, help="结束帧，0 表示用场景设置")
    parser.add_argument("--fps", type=float, default=0, help="帧率，0 表示用场景设置")
    parser.add_argument("--res", default="", help="分辨率，形如 1280x720，留空用场景设置")
    parser.add_argument("--percent", type=int, default=100, help="分辨率百分比，草稿可用 50")
    parser.add_argument("--engine", default="workbench", help="workbench / eevee / cycles")
    parser.add_argument("--samples", type=int, default=0, help="非 Workbench 引擎的采样数")
    parser.add_argument("--frames-dir", default="", help="给了就只输出 PNG 序列到该目录")
    parser.add_argument("--background", default="#70747C", help="Workbench 背景色，#RRGGBB")
    parser.add_argument("--probe", action="store_true", help="只校验并报告场景信息，不渲染")
    return parser.parse_args(raw)


def srgb_to_linear(value):
    """Workbench 的背景色吃线性值，直接把 sRGB 分量塞进去会偏亮。"""
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_to_linear_rgb(text):
    raw = str(text or "").strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6:
        die("BAD_BACKGROUND", f"背景色需要 #RRGGBB 形式，收到：{text}")
    try:
        channels = [int(raw[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        die("BAD_BACKGROUND", f"背景色不是合法十六进制：{text}")
    return tuple(srgb_to_linear(channel) for channel in channels)


def parse_resolution(text):
    if not text:
        return None
    parts = str(text).lower().replace("×", "x").split("x")
    if len(parts) != 2:
        die("BAD_RESOLUTION", f"分辨率需要 宽x高 形式，收到：{text}")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        die("BAD_RESOLUTION", f"分辨率不是整数：{text}")
    if width < 16 or height < 16:
        die("BAD_RESOLUTION", f"分辨率过小：{text}")
    return width, height


def available_engines():
    # 只用于报错时给提示。Blender 的 engine 枚举是动态的，后台模式下可能只列出部分引擎
    # （实测 5.2 只报 BLENDER_EEVEE，但 BLENDER_WORKBENCH 实际可赋值），不能拿它当门禁。
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
        return sorted({item.identifier for item in prop.enum_items})
    except Exception:
        return []


def open_scene(path):
    scene_path = Path(path).expanduser()
    if not scene_path.is_file():
        die("SCENE_NOT_FOUND", f"场景文件不存在：{scene_path}", path=str(scene_path))
    try:
        bpy.ops.wm.open_mainfile(filepath=str(scene_path))
    except Exception as error:
        die("SCENE_OPEN_FAILED", f"无法打开场景：{error}", path=str(scene_path))


def resolve_camera(scene, wanted):
    if wanted:
        obj = bpy.data.objects.get(wanted)
        if obj is None:
            die("CAMERA_NOT_FOUND", f"场景里没有名为 {wanted} 的对象", available=[o.name for o in bpy.data.objects if o.type == "CAMERA"])
        if obj.type != "CAMERA":
            die("NOT_A_CAMERA", f"{wanted} 不是相机，类型是 {obj.type}")
        return obj
    if scene.camera is None:
        cameras = [o.name for o in bpy.data.objects if o.type == "CAMERA"]
        die(
            "NO_CAMERA",
            "场景没有设置活动相机，请指定 --camera 或在 Blender 里设为活动相机",
            available=cameras,
        )
    return scene.camera


def apply_engine(scene, engine, samples):
    keyword = str(engine or "").strip().lower()
    wanted = ENGINE_ALIASES.get(keyword, str(engine or "").strip())
    if not wanted:
        return scene.render.engine

    # 不查枚举，直接赋值试错：枚举里没列出来的引擎（如 Workbench）往往照样能设
    candidates = [wanted]
    if wanted == "BLENDER_EEVEE_NEXT":
        candidates.append("BLENDER_EEVEE")
    if wanted == "BLENDER_EEVEE":
        candidates.append("BLENDER_EEVEE_NEXT")

    chosen = None
    for candidate in candidates:
        try:
            scene.render.engine = candidate
            chosen = candidate
            break
        except (TypeError, AttributeError):
            continue
    if chosen is None:
        die(
            "ENGINE_UNSUPPORTED",
            f"当前 Blender 无法使用引擎 {wanted}，可试 workbench / eevee / cycles",
            listed=available_engines(),
        )

    if samples > 0:
        if chosen == "CYCLES":
            scene.cycles.samples = samples
        elif hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
            scene.eevee.taa_render_samples = samples
    return chosen


def apply_workbench_look(scene, background_hex):
    """白模外观：单色灰 + 投影 + cavity。投影是飞行镜头里唯一的深度线索。"""
    shading = getattr(scene.display, "shading", None)
    if shading is None:
        return
    settings = {
        "light": "STUDIO",
        "color_type": "SINGLE",
        "single_color": (0.82, 0.82, 0.82),
        "show_shadows": True,
        "show_cavity": True,
        "shadow_intensity": 0.35,
        "cavity_type": "BOTH",
        # 后台渲染下背景默认走 Theme，出来是纯黑，看着像没渲
        "background_type": "VIEWPORT",
        "background_color": hex_to_linear_rgb(background_hex),
    }
    for attr, value in settings.items():
        if hasattr(shading, attr):
            try:
                setattr(shading, attr, value)
            except (AttributeError, TypeError):
                pass
    try:
        scene.display.render_aa = "8"
    except (AttributeError, TypeError):
        pass
    try:
        scene.view_settings.view_transform = "Standard"  # AgX 会把灰压暗
    except (AttributeError, TypeError):
        pass


def configure_output(scene, out_path, frames_dir):
    """返回实际会写出的路径。编码参数按 Seedance 参考视频的要求定：H.264、无音轨。

    路径一律转绝对：Blender 会把相对路径按 .blend 所在目录解析，桥接传进来的相对路径
    十有八九会落到意料之外的位置，最后表现为"渲染成功但没有文件"。
    """
    image_settings = scene.render.image_settings
    if frames_dir:
        target = Path(frames_dir).expanduser().resolve()
        target.mkdir(parents=True, exist_ok=True)
        if hasattr(image_settings, "media_type"):
            image_settings.media_type = "IMAGE"
        image_settings.file_format = "PNG"
        image_settings.color_mode = "RGB"
        scene.render.filepath = str(target / "r_")
        scene.render.use_file_extension = True
        return str(target)

    if not out_path:
        die("MISSING_OUT", "没有指定 --out，也没有 --frames-dir")
    target = Path(out_path).expanduser().resolve()
    if target.suffix.lower() != ".mp4":
        target = target.with_suffix(".mp4")
    target.parent.mkdir(parents=True, exist_ok=True)

    # Blender 5.x 起输出格式拆成 media_type + file_format，顺序不能反
    if hasattr(image_settings, "media_type"):
        image_settings.media_type = "VIDEO"
    image_settings.file_format = "FFMPEG"
    image_settings.color_mode = "RGB"
    scene.render.filepath = str(target)
    scene.render.use_file_extension = True

    ffmpeg = getattr(scene.render, "ffmpeg", None)
    if ffmpeg is not None:
        for attr, value in (
            ("format", "MPEG4"),
            ("codec", "H264"),
            ("constant_rate_factor", "HIGH"),
            ("ffmpeg_preset", "GOOD"),
            # 参考视频不需要音轨，带上反而可能被上游拒
            ("audio_codec", "NONE"),
        ):
            if hasattr(ffmpeg, attr):
                try:
                    setattr(ffmpeg, attr, value)
                except (AttributeError, TypeError):
                    pass
    return str(target)


SHOT_EASING = {
    "linear": ("LINEAR", "AUTO"),
    "easeIn": ("BEZIER", "EASE_IN"),
    "easeOut": ("BEZIER", "EASE_OUT"),
    "easeInOut": ("BEZIER", "EASE_IN_OUT"),
}


def scene_bounds():
    """所有网格对象的世界包围盒。用来定环绕中心和透镜距离，比硬编码一个值可靠。"""
    mins = [float("inf")] * 3
    maxs = [float("-inf")] * 3
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                mins[axis] = min(mins[axis], world[axis])
                maxs[axis] = max(maxs[axis], world[axis])
    if mins[0] == float("inf"):
        return None
    return mins, maxs


def pivot_of(bounds):
    """场景中心。相机离它多远决定了「推近多少算推近」，没有它就没法给合理默认幅度。"""
    if not bounds:
        return Vector((0.0, 0.0, 0.0))
    mins, maxs = bounds
    return Vector(tuple((mins[axis] + maxs[axis]) / 2.0 for axis in range(3)))


def action_fcurves(action):
    """取 action 里的曲线。Blender 4.4 起曲线挂在 layer/strip/channelbag 下，旧字段仍兼容。"""
    layered = []
    for layer in getattr(action, "layers", None) or []:
        for strip in getattr(layer, "strips", None) or []:
            for bag in getattr(strip, "channelbags", None) or []:
                layered.extend(getattr(bag, "fcurves", None) or [])
    if layered:
        return layered
    try:
        return list(action.fcurves)
    except Exception:
        return []


def camera_details(active):
    """列出全部相机及其「有没有动画、动画帧区间」。

    档二（选现成机位）全靠这份数据：用户得能看出哪个是静止的、哪个美术已经 K 了运镜，
    否则只能靠相机名瞎猜。
    """
    items = []
    for obj in bpy.data.objects:
        if obj.type != "CAMERA":
            continue
        frames = None
        for holder in (obj, obj.data):
            data = getattr(holder, "animation_data", None)
            action = getattr(data, "action", None) if data else None
            if action is None:
                continue
            span = action.frame_range
            low, high = float(span[0]), float(span[1])
            frames = [low, high] if frames is None else [min(frames[0], low), max(frames[1], high)]
        matrix = obj.matrix_world
        position = matrix.translation.copy()
        forward = (matrix.to_quaternion() @ Vector((0.0, 0.0, -1.0))).normalized()
        items.append(
            {
                "name": obj.name,
                "active": bool(active is not None and obj == active),
                "animated": frames is not None,
                "frameRange": frames,
                "lens": round(float(obj.data.lens), 2),
                "location": [round(value, 4) for value in position],
                "forward": [round(value, 4) for value in forward],
            }
        )
    return items


def load_shot(path):
    try:
        payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except Exception as error:
        die("BAD_SHOT", f"无法读取镜头描述 {path}：{error}")
    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list) or len(keys) < 2:
        die("BAD_SHOT", "镜头描述至少要有 2 个关键帧。")
    return payload


def apply_shot(scene, shot):
    """把关键帧插到一台复制出来的相机上。

    复制而不是直接改原相机：原相机上美术 K 好的动画会和这里写的关键帧打架，
    表现为画面来回跳。复制一份、清掉动画，等于新建了一台只属于这次渲染的相机。
    """
    base_name = str(shot.get("camera") or "").strip()
    if base_name:
        base = bpy.data.objects.get(base_name)
        if base is None or base.type != "CAMERA":
            die(
                "CAMERA_NOT_FOUND",
                f"镜头描述里的相机 {base_name} 不存在",
                available=[obj.name for obj in bpy.data.objects if obj.type == "CAMERA"],
            )
    else:
        base = scene.camera
        if base is None:
            die("NO_CAMERA", "镜头描述没有指定相机，场景也没有活动相机。")

    cam_data = base.data.copy()
    cam = bpy.data.objects.new("__shot_camera__", cam_data)
    scene.collection.objects.link(cam)
    for holder in (cam, cam_data):
        if holder.animation_data:
            holder.animation_data_clear()
    # 四元数插值：环绕 90° 时欧拉角会翻轴，四元数不会
    cam.rotation_mode = "QUATERNION"

    fps = scene.render.fps or 24
    # 一秒 24fps 就该是 24 帧（第 1..24 帧）。终点关键帧若落到第 25 帧，
    # 要么多渲一帧（时长变成 1.04 秒），要么最后一帧差一点没走到位。
    # 统一夹到总帧数上：最后一帧正好是终点姿态，帧数也精确。
    total_frames = None
    try:
        duration = float(shot.get("durationSec") or 0)
        if duration > 0:
            total_frames = max(2, round(duration * fps))
    except (TypeError, ValueError):
        total_frames = None

    first_frame = None
    last_frame = None
    for index, key in enumerate(shot["keys"]):
        try:
            at = 1 + round(float(key["t"]) * fps)
            position = Vector(key["pos"])
            target = Vector(key["target"])
        except (KeyError, TypeError, ValueError):
            die("BAD_SHOT", f"第 {index + 1} 个关键帧字段不合法。")
        if total_frames is not None:
            at = min(at, total_frames)
        direction = target - position
        if direction.length < 1e-6:
            die("BAD_SHOT", f"第 {index + 1} 个关键帧的相机位置与目标点重合。")
        cam.location = position
        cam.rotation_quaternion = direction.to_track_quat("-Z", "Y")
        if key.get("focal"):
            cam.data.lens = float(key["focal"])
        cam.keyframe_insert("location", frame=at)
        cam.keyframe_insert("rotation_quaternion", frame=at)
        cam.data.keyframe_insert("lens", frame=at)
        first_frame = at if first_frame is None else min(first_frame, at)
        last_frame = at if last_frame is None else max(last_frame, at)

    interpolation, easing = SHOT_EASING.get(str(shot.get("easing") or "easeInOut"), SHOT_EASING["easeInOut"])
    for holder in (cam, cam_data):
        data = getattr(holder, "animation_data", None)
        action = getattr(data, "action", None) if data else None
        if action is None:
            continue
        for curve in action_fcurves(action):
            for point in curve.keyframe_points:
                point.interpolation = interpolation
                if interpolation == "BEZIER":
                    point.easing = easing

    scene.camera = cam
    return cam, {
        "preset": str(shot.get("preset") or ""),
        "keys": len(shot["keys"]),
        "camera": cam.name,
        "firstFrame": first_frame,
        "lastFrame": last_frame,
    }


def probe_payload(scene, args):
    """探测结果。相机解析失败不视为错误——档二要先列出机位再让用户选。"""
    frame_start = args.start or scene.frame_start
    frame_end = args.end or scene.frame_end
    total = max(1, frame_end - frame_start + 1)
    fps = args.fps or scene.render.fps or 24
    resolution = parse_resolution(args.res)
    width = resolution[0] if resolution else scene.render.resolution_x
    height = resolution[1] if resolution else scene.render.resolution_y

    active = None
    wanted = (args.camera or "").strip()
    if wanted:
        candidate = bpy.data.objects.get(wanted)
        if candidate is not None and candidate.type == "CAMERA":
            active = candidate
    else:
        active = scene.camera

    bounds = scene_bounds()
    pivot = pivot_of(bounds)
    details = camera_details(active)
    # 补一个注视点：位置 + 前向 × 到场景中心的距离。前端拿它算推近幅度，不用再猜距离
    for item in details:
        distance = (pivot - Vector(item["location"])).length
        if distance < 1e-3:
            distance = 10.0
        item["target"] = [round(value, 4) for value in Vector(item["location"]) + Vector(item["forward"]) * distance]

    return {
        "ok": True,
        "scene": str(Path(args.scene).expanduser()),
        "camera": active.name if active else None,
        "cameras": [item["name"] for item in details],
        "cameraDetails": details,
        "pivot": [round(value, 4) for value in pivot],
        "bounds": None
        if not bounds
        else {"min": [round(value, 3) for value in bounds[0]], "max": [round(value, 3) for value in bounds[1]]},
        "objects": len(bpy.data.objects),
        "frameStart": frame_start,
        "frameEnd": frame_end,
        "frames": total,
        "fps": fps,
        "resolution": f"{width}x{height}",
        "percent": scene.render.resolution_percentage,
        "engine": scene.render.engine,
        "durationSeconds": round(total / max(1, fps), 3),
    }


def main():
    args = parse_args()
    if not args.scene:
        die("MISSING_SCENE", "必须提供 --scene")
    open_scene(args.scene)

    scene = bpy.context.scene

    if args.probe:
        emit("PROBE", probe_payload(scene, args))
        return

    # 关键帧要按最终帧率换算秒→帧，所以 fps 必须先把定下来，再运镜
    fps = args.fps or scene.render.fps or 24
    scene.render.fps = int(round(fps))
    scene.render.fps_base = 1.0

    camera = resolve_camera(scene, args.camera)
    shot_meta = None
    if args.shot:
        camera, shot_meta = apply_shot(scene, load_shot(args.shot))

    frame_start = args.start or scene.frame_start
    frame_end = args.end or scene.frame_end
    if shot_meta and not args.end:
        # 没显式给结束帧就按镜头最后一帧收尾，避免渲出一段静止的尾巴
        frame_end = max(frame_start, shot_meta["lastFrame"])
    if frame_end < frame_start:
        die("BAD_FRAME_RANGE", f"结束帧 {frame_end} 早于起始帧 {frame_start}", start=frame_start, end=frame_end)
    total = frame_end - frame_start + 1

    resolution = parse_resolution(args.res)
    width = resolution[0] if resolution else scene.render.resolution_x
    height = resolution[1] if resolution else scene.render.resolution_y

    scene.frame_start = frame_start
    scene.frame_end = frame_end
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = max(1, min(100, args.percent))
    scene.camera = camera

    engine = apply_engine(scene, args.engine, args.samples)
    if engine == "BLENDER_WORKBENCH":
        apply_workbench_look(scene, args.background)
    else:
        try:
            scene.view_settings.view_transform = "Standard"
        except (AttributeError, TypeError):
            pass

    target = configure_output(scene, args.out, args.frames_dir)

    started_at = time.time()
    state = {"count": 0}

    def report(scene_ref, _depsgraph=None):
        state["count"] += 1
        frame = scene_ref.frame_current
        elapsed = time.time() - started_at
        done = max(0, frame - frame_start + 1)
        emit(
            "PROGRESS",
            {
                "frame": frame,
                "rendered": done,
                "total": total,
                "percent": round(min(100.0, done * 100.0 / total), 1),
                "elapsed": round(elapsed, 2),
                "perFrameMs": round(elapsed * 1000.0 / max(1, state["count"])),
            },
        )

    handlers = bpy.app.handlers.render_post
    handlers.append(report)
    try:
        bpy.ops.render.render(animation=True)
    except Exception as error:
        handlers.remove(report)
        die("RENDER_FAILED", f"渲染中断：{error}", exit_code=3)
    finally:
        if report in handlers:
            handlers.remove(report)

    elapsed = round(time.time() - started_at, 2)
    if args.frames_dir:
        emit(
            "RESULT",
            {
                "ok": True,
                "kind": "frames",
                "out": target,
                "frames": total,
                "fps": scene.render.fps,
                "engine": engine,
                "seconds": elapsed,
                "shot": shot_meta,
            },
        )
        return

    output = Path(target)
    if not output.is_file() or output.stat().st_size <= 0:
        # 少数版本会在文件名后追加帧范围，兜底找一次
        candidates = sorted(output.parent.glob(f"{output.stem}*.mp4"))
        if not candidates:
            die("OUTPUT_MISSING", "渲染结束但没有生成文件，检查 --out 路径与编码设置", exit_code=4, expected=target)
        output = candidates[0]

    size = output.stat().st_size
    emit(
        "RESULT",
        {
            "ok": True,
            "kind": "video",
            "out": str(output),
            "bytes": size,
            "frames": total,
            "fps": scene.render.fps,
            "resolution": f"{width}x{height}",
            "percent": scene.render.resolution_percentage,
            "engine": engine,
            "seconds": elapsed,
            "durationSeconds": round(total / max(1, scene.render.fps), 3),
            "perFrameMs": round(elapsed * 1000.0 / max(1, total)),
            "shot": shot_meta,
        },
    )


if __name__ == "__main__":
    main()
