# Builds the two custom MapLibre styles (A night 3D, B daylight flat) as style.json + style.js
import json, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def style(p, three_d):
    cls = lambda *c: ["match", ["get", "class"], list(c), True, False]
    notunnel = ["!=", ["get", "brunnel"], "tunnel"]
    def road(id, classes, color, w, minzoom=0):
        return {"id": id, "type": "line", "source": "omt", "source-layer": "transportation", "minzoom": minzoom,
                "filter": ["all", cls(*classes), notunnel],
                "layout": {"line-cap": "round", "line-join": "round"},
                "paint": {"line-color": color, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, w[0], 14, w[1], 18, w[2]]}}
    L = [
        {"id": "land", "type": "background", "paint": {"background-color": p["land"]}},
        {"id": "park", "type": "fill", "source": "omt", "source-layer": "park", "paint": {"fill-color": p["park"]}},
        {"id": "green", "type": "fill", "source": "omt", "source-layer": "landcover", "filter": cls("grass", "wood"), "paint": {"fill-color": p["park"]}},
        {"id": "water", "type": "fill", "source": "omt", "source-layer": "water", "filter": notunnel, "paint": {"fill-color": p["water"]}},
        {"id": "waterway", "type": "line", "source": "omt", "source-layer": "waterway", "paint": {"line-color": p["water"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 3]}},
        {"id": "aeroway", "type": "fill", "source": "omt", "source-layer": "aeroway", "filter": ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], True, False], "paint": {"fill-color": p["road1"]}},
        road("road-minor", ["minor", "service"], p["road1"], [0.2, 1.0, 9], 12),
        road("road-mid", ["secondary", "tertiary"], p["road2"], [0.5, 1.8, 14]),
        road("road-major", ["primary", "trunk"], p["road3"], [0.8, 2.6, 20]),
        road("road-motorway", ["motorway"], p["road4"], [1.0, 3.0, 22]),
        {"id": "rail", "type": "line", "source": "omt", "source-layer": "transportation", "filter": cls("rail", "transit"),
         "paint": {"line-color": p["rail"], "line-width": 1, "line-dasharray": [2, 2]}},
    ]
    if three_d:
        L.append({"id": "buildings-3d", "type": "fill-extrusion", "source": "omt", "source-layer": "building", "minzoom": 13,
                  "filter": ["!", ["has", "hide_3d"]],
                  "paint": {"fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 6], 0, p["bldg_lo"], 40, p["bldg_hi"]],
                            "fill-extrusion-height": ["*", p.get("hx", 1), ["coalesce", ["get", "render_height"], 6]],
                            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                            "fill-extrusion-opacity": 0.92}})
    else:
        L.append({"id": "buildings", "type": "fill", "source": "omt", "source-layer": "building", "minzoom": 14,
                  "paint": {"fill-color": p["bldg_lo"], "fill-outline-color": p["bldg_hi"]}})
    font = ["Noto Sans Regular"]
    L += [
        {"id": "label-road", "type": "symbol", "source": "omt", "source-layer": "transportation_name", "minzoom": 14,
         "filter": cls("primary", "trunk", "secondary"),
         "layout": {"symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": font, "text-size": 10.5, "text-letter-spacing": 0.02},
         "paint": {"text-color": p["label2"], "text-halo-color": p["halo"], "text-halo-width": 1.2}},
        {"id": "label-place", "type": "symbol", "source": "omt", "source-layer": "place", "minzoom": 11,
         "filter": cls("suburb", "neighbourhood", "quarter"),
         "layout": {"text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": font,
                    "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 12.5], "text-max-width": 8, "text-padding": 6},
         "paint": {"text-color": p["label"], "text-halo-color": p["halo"], "text-halo-width": 1.2}},
    ]
    return {"version": 8, "name": p["name"],
            "sources": {"omt": {"type": "vector", "url": "https://tiles.openfreemap.org/planet",
                                "attribution": "© OpenMapTiles © OpenStreetMap contributors"}},
            "glyphs": "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
            "light": p.get("light", {"anchor": "viewport", "position": [1.2, 210, 30], "intensity": 0.35}),
            "layers": L}

A = dict(name="Circle night", hx=1.8, land="#060709", park="#0A110D", water="#0B1724", road1="#13161C", road2="#1B1F27", road3="#323844",
         road4="#424958", rail="#1F232B", bldg_lo="#181B22", bldg_hi="#3A404C", label="#555C68", label2="#3E444E", halo="#060709",
         light={"anchor": "viewport", "color": "#ffffff", "position": [1.3, 200, 40], "intensity": 0.42})
B = dict(name="Circle day", land="#FFFFFF", park="#E8F2E4", water="#CFE1F4", road1="#EDEEF1", road2="#E2E4E9", road3="#D5D8E0",
         road4="#CACFD9", rail="#DADCE2", bldg_lo="#F3F4F6", bldg_hi="#E7E8EC", label="#8A909B", label2="#A5AAB3", halo="#FFFFFF")
for key, pal, td in (("A", A, True), ("B", B, False)):
    s = style(pal, td)
    os.makedirs(f"{ROOT}/{key}", exist_ok=True)
    json.dump(s, open(f"{ROOT}/{key}/style.json", "w"), indent=1)
    open(f"{ROOT}/{key}/style.js", "w").write("window.MAP_STYLE = " + json.dumps(s) + ";\n")
print("ok")
