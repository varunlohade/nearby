# Round 3 brief — "nearby": the whole city is a 3D game map

Owner (verbatim, 2026-11-19): "dark 3d one is good but imaging its a game and make the entire map threed"
Earlier: "a person opens up the website the whole screen is a cool map", "things keep pooping up like pokemon go",
"imaging opening up the website a map arrives this map has all live activity going on".
Name: nearby.

Owner, more (verbatim): "like google earth 3d" (= the swooping 3D camera feel; we stay free/stylised, not photo tiles)
and "it should have popups in areas of whats going on here, at some place a concert is going on at other places
something else is going on but on the map its rendered"

## Happenings rendered IN the map (the core of this round)
Each happening sits at its exact spot and is RENDERED in the 3D scene, not as a flat web card:
- a concert at a venue: pulsing light beams/rings rising from the building, a floating "LIVE · Concert" tag, crowd count
- a market / food stall street: a warm glowing strip along that road
- a cricket/football match at a ground: the ground lit up, score-style floating tag
- a run club / cycle ride: an animated glowing path along real roads
- a lost-pet or help post: a small pulsing beacon with a short bubble
- people joining an area: little particles flowing into that area
At least 8 happenings of at least 5 types across the city, each visibly different, each animated.
Use MapLibre fill-extrusion / line / circle layers or deck.gl layers anchored to real coordinates.
Clicking a happening opens its peek (what, where, when, how many here, Join chat).

## Picked base
Dark night city, tilted 3D buildings, glowing amber neighbourhood areas, live pop-ups floating on the map,
a slim "What's happening" feed. Now push it into a GAME feel:
- EVERYTHING is 3D: all buildings extruded across the whole city (not just near the centre), steep pitch (~60°),
  areas are raised glowing plates/walls, event pins are 3D beacons (light pillars), people-counts float like HUD tags.
- Opening the site = an intro: camera flies in from high above to the city, areas light up one by one.
- Live pop-ups spawn like game items: bounce in, glow, fade. A new one every 1-3 s.
- Game HUD instead of web panels: compact, translucent, corner-anchored, small caps labels, a live counter
  ("312 people out right now"). Still readable; the chat panel can stay a normal messenger, docked right.
- Do NOT copy Pokémon Go, GTA or any real game's art, icons or UI. Original only. No audio, ever.

## Easy to develop (still a hard rule)
MapLibre GL JS only (+ optional deck.gl from a CDN), keyless OpenFreeMap vector tiles, your own style JSON,
fill-extrusion for buildings and area walls, simple HTML markers or deck.gl layers for pop-ups.
No game engine, no Three.js scene, no custom 3D models. A dev should rebuild it in a day.

## Deliver (desktop 1440x900 + mobile 390x844), sample data in Bengaluru
(areas: Indiranagar, Koramangala, HSR Layout, Jayanagar, Whitefield, Malleshwaram)
1. intro — mid fly-in frame.  2. map — the live game map.  3. peek — clicked an area.
4. build — clicked an empty area: "Build your neighbourhood".  5. chat — chat docked right, 3D map still live.
6. mobile — screen 2 on a phone.
Make 2 directions (A, B) that differ in structure/HUD layout and how the 3D city is styled, not only colour.
Each page self-contained; animation must really run in the HTML.
