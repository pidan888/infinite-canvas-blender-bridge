"""Create a simple, editable animated mannequin scene from MediaPipe pose landmarks."""

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector


LANDMARK_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye",
    "right_eye_outer", "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_pinky",
    "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb", "left_hip",
    "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index",
]

BONES = [
    (11, 12, 0.09), (11, 13, 0.055), (13, 15, 0.04), (12, 14, 0.055), (14, 16, 0.04),
    (11, 23, 0.11), (12, 24, 0.11), (23, 24, 0.09), (23, 25, 0.065), (25, 27, 0.05),
    (24, 26, 0.065), (26, 28, 0.05), (27, 31, 0.035), (28, 32, 0.035),
    (0, 11, 0.065), (0, 12, 0.065),
]
ACTIVE_JOINTS = sorted({index for start, end, _ in BONES for index in (start, end)})


def emit_error(message):
    print(f"POSE_SCENE_ERROR {message}", file=sys.stderr, flush=True)


def parse_args():
    argv = sys.argv
    raw = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(raw)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def pose_points(frame):
    points = []
    for x, y, z, visibility in frame["landmarks"]:
        # MediaPipe uses a hip-centered, camera-relative coordinate system; Blender is Z-up.
        points.append(Vector((x, -z, -y)) if visibility >= 0.15 else None)
    return points


def create_joint(index, radius):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=radius)
    obj = bpy.context.object
    obj.name = f"Joint_{index:02d}_{LANDMARK_NAMES[index]}"
    obj.data.name = obj.name
    return obj


def create_bone(start, end, radius):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=1, depth=2)
    obj = bpy.context.object
    obj.name = f"Segment_{LANDMARK_NAMES[start]}_{LANDMARK_NAMES[end]}"
    obj.data.name = obj.name
    obj.scale.x = radius
    obj.scale.y = radius
    return obj


def set_bone_transform(obj, start, end):
    direction = end - start
    length = max(direction.length, 0.001)
    obj.location = (start + end) / 2
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction.normalized())
    obj.scale.z = length / 2


def key_object(obj, frame_number):
    obj.keyframe_insert(data_path="location", frame=frame_number)
    if obj.rotation_mode == "QUATERNION":
        obj.keyframe_insert(data_path="rotation_quaternion", frame=frame_number)
    obj.keyframe_insert(data_path="scale", frame=frame_number)


def create_camera_and_light(scene):
    bpy.ops.object.camera_add(location=(0, -4.5, 1.25))
    camera = bpy.context.object
    camera.name = "ReconstructionCamera"
    target = Vector((0, 0, 0.85))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 50
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(0, -2.5, 3.5))
    light = bpy.context.object
    light.name = "ReconstructionKeyLight"
    light.data.energy = 500
    light.data.shape = "DISK"
    light.data.size = 4
    light.rotation_euler = (Vector((0, 0, 0.85)) - light.location).to_track_quat("-Z", "Y").to_euler()


def build_scene(data, output_path):
    frames = data["frames"]
    fps = data["fps"]
    frame_numbers = [1 + round(frame["timeSec"] * fps) for frame in frames]
    poses = [pose_points(frame) for frame in frames]

    # Keep one consistent scale and floor offset across the clip.
    height_samples = []
    foot_heights = []
    for points in poses:
        head = points[0]
        ankles = [points[index] for index in (27, 28) if points[index] is not None]
        if head is not None and ankles:
            height_samples.append(max(point.z for point in ankles) - head.z)
        foot_heights.extend(point.z for index in (27, 28, 29, 30, 31, 32) if (point := points[index]) is not None)
    measured_height = sorted(height_samples)[len(height_samples) // 2] if height_samples else 1.0
    scale = 1.7 / max(abs(measured_height), 0.35)
    floor_z = min(foot_heights, default=0.0) * scale

    def transform(point):
        if point is None:
            return None
        return Vector((point.x * scale, point.y * scale, point.z * scale - floor_z))

    poses = [[transform(point) for point in points] for points in poses]
    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.frame_start = 1
    scene.frame_end = max(frame_numbers)
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.world.color = (0.08, 0.08, 0.08)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True

    joint_objects = {
        index: create_joint(index, 0.12 if index == 0 else 0.06 if index in (11, 12, 23, 24) else 0.035)
        for index in ACTIVE_JOINTS
    }
    bone_objects = [((start, end), create_bone(start, end, radius)) for start, end, radius in BONES]

    for frame_index, points in enumerate(poses):
        frame_number = frame_numbers[frame_index]
        for index, obj in joint_objects.items():
            point = points[index]
            if index == 0 and point is not None:
                ears = [points[ear] for ear in (7, 8) if points[ear] is not None]
                if ears:
                    point = (point + sum(ears, Vector((0, 0, 0)))) / (len(ears) + 1)
            if point is None:
                continue
            obj.location = point
            obj.keyframe_insert(data_path="location", frame=frame_number)
        for (start_index, end_index), obj in bone_objects:
            start = points[start_index]
            end = points[end_index]
            if start is None or end is None:
                continue
            set_bone_transform(obj, start, end)
            key_object(obj, frame_number)

    create_camera_and_light(scene)
    scene.frame_set(scene.frame_start)
    scene["reconstruction_source"] = "MediaPipe Pose Landmarker"
    scene["reconstruction_note"] = "Generic editable mannequin; person appearance and absolute camera motion are not reconstructed."
    scene["source_video_name"] = data["sceneName"]
    bpy.ops.wm.save_as_mainfile(filepath=str(output_path))


def main():
    args = parse_args()
    source = Path(args.input)
    output = Path(args.output)
    try:
        with source.open("r", encoding="utf-8") as file:
            data = json.load(file)
        build_scene(data, output)
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("Blender did not create the scene file.")
    except Exception as error:
        emit_error(str(error))
        raise


if __name__ == "__main__":
    main()
