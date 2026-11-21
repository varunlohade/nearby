"""Rasterise Natural Earth coastlines and country borders into one
equirectangular line texture for the stylised globe.

    R channel: coastlines      G channel: country borders

Usage (data files are public domain, from naturalearthdata.com):
    python3 -I tools/build-atlas-lines.py <ne_50m_coastline.geojson> \
        <ne_50m_admin_0_boundary_lines_land.geojson> app/public/textures/atlas_lines_4096.png

Needs only numpy. The output matches the day texture's layout: longitude
-180..180 left to right, latitude 90..-90 top to bottom.
"""
import json
import struct
import sys
import zlib

import numpy as np

W, H = 4096, 2048


def lines(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    for feature in data["features"]:
        geometry = feature.get("geometry") or {}
        kind, coords = geometry.get("type"), geometry.get("coordinates") or []
        if kind == "LineString":
            yield coords
        elif kind == "MultiLineString":
            yield from coords


def draw(channel, path):
    """Splat each segment at half-texel steps with a soft 3x3 footprint."""
    kernel = np.array([[0.25, 0.55, 0.25], [0.55, 1.0, 0.55], [0.25, 0.55, 0.25]], dtype=np.float32)
    for line in lines(path):
        pts = np.array(line, dtype=np.float64)
        if len(pts) < 2:
            continue
        x = (pts[:, 0] + 180.0) / 360.0 * W
        y = (90.0 - pts[:, 1]) / 180.0 * H
        for i in range(len(pts) - 1):
            dx, dy = x[i + 1] - x[i], y[i + 1] - y[i]
            if abs(dx) > W / 2:  # skip segments that wrap across the antimeridian
                continue
            steps = int(max(abs(dx), abs(dy)) * 2) + 1
            t = np.linspace(0.0, 1.0, steps)
            px = np.round(x[i] + dx * t).astype(int) % W
            py = np.clip(np.round(y[i] + dy * t).astype(int), 0, H - 1)
            for oy in (-1, 0, 1):
                for ox in (-1, 0, 1):
                    yy = np.clip(py + oy, 0, H - 1)
                    xx = (px + ox) % W
                    np.maximum.at(channel, (yy, xx), kernel[oy + 1, ox + 1])


def write_png(path, rgb):
    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(rgb.shape[0]))
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", rgb.shape[1], rgb.shape[0], 8, 2, 0, 0, 0)
    with open(path, "wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    coast_path, border_path, out_path = sys.argv[1:4]
    coast = np.zeros((H, W), dtype=np.float32)
    border = np.zeros((H, W), dtype=np.float32)
    draw(coast, coast_path)
    draw(border, border_path)
    rgb = np.zeros((H, W, 3), dtype=np.uint8)
    rgb[..., 0] = np.round(coast * 255)
    rgb[..., 1] = np.round(border * 255)
    write_png(out_path, rgb)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
