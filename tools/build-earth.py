"""Prepare NASA VTAD's Earth mesh for the website.

    blender --background --python tools/build-earth.py [-- path/to/original.glb]

Source: https://science.nasa.gov/resource/earth-with-clouds-3d-model/
Usage: https://www.nasa.gov/nasa-brand-center/images-and-media/
The original model is downloaded when no local file is supplied.
"""
import math
import sys
import tempfile
import urllib.request
from pathlib import Path

import bpy

URL = "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/e/EarthClouds_1_12756.glb"
OUTPUT = Path(__file__).resolve().parents[1] / "app/public/models/earth.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)

with tempfile.TemporaryDirectory() as scratch:
    if "--" in sys.argv:
        source = Path(sys.argv[sys.argv.index("--") + 1])
    else:
        source = Path(scratch) / "EarthClouds.glb"
        urllib.request.urlretrieve(URL, source)
    bpy.ops.import_scene.gltf(filepath=str(source))

earth = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
earth.name = "Earth"
mesh = earth.data
# Retain the source's oblate shape. Its cube atlas becomes a geographic UV
# map, so the website can sample day, night, water and cloud maps together.
scale = 1.6 / max(vertex.co.length for vertex in mesh.vertices)
for vertex in mesh.vertices:
    vertex.co *= scale
uv = mesh.uv_layers.active.data
for face in mesh.polygons:
    face.use_smooth = True
    coords = []
    for i in face.loop_indices:
        p = mesh.vertices[mesh.loops[i].vertex_index].co.normalized()
        coords.append([0.5 + math.atan2(p.x, -p.y) / math.tau, 0.5 + math.asin(p.z) / math.pi])
    if max(u for u, v in coords) - min(u for u, v in coords) > 0.5:
        for point in coords:
            if point[0] < 0.5:
                point[0] += 1
    for i, coord in zip(face.loop_indices, coords):
        uv[i].uv = coord
mesh.materials.clear()
earth["credit"] = "NASA Visualization Technology Applications and Development (VTAD)"
earth["source"] = "https://science.nasa.gov/resource/earth-with-clouds-3d-model/"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(OUTPUT), export_format="GLB", export_extras=True)
