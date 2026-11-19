# Inspiration — round 2 (map is the whole screen)

Board: `ref/board.png` (headless captures; Snap Map, Strava and Flightradar hid the map behind login or bot walls, so their notes come from the live products).

| # | Reference | Shot | Steal |
|---|-----------|------|-------|
| 1 | Felt — https://felt.com | `ref/felt.png` | Real chat messages float as small white cards right on the map, with one tiny summary card ("Pothole reports 4 / 3") — proof that a messenger can live on a map without a sheet. |
| 2 | Snap Map — https://map.snapchat.com | `ref/snapmap.png` (login wall) | Activity is drawn as area intensity, not dots: busy parts of the city are simply stronger colour. Our "busy right now" polygons copy that idea. |
| 3 | Citizen — https://citizen.com | `ref/citizen.png` | An incident lands on the map as a pin with a short one-line caption, then a ring spreads out from it. That is our "event drops in" + "3 people joined" ripple. |
| 4 | Strava Global Heatmap — https://www.strava.com/maps/global-heatmap | `ref/strava.png` (cookie wall) | On a near-black base, brightness alone carries the data. Direction A uses that: the city is dark, only live areas get colour. |
| 5 | Mapbox Standard (dusk / night light presets) — https://docs.mapbox.com/map-styles/standard/guides/ | `ref/mapbox-standard.png` | Tilted 3D buildings in one low-contrast tone, labels pushed back, so the extruded city reads as one sculpted mass. Direction A's 3D city. |
| 6 | Flightradar24 — https://www.flightradar24.com | `ref/flightradar.png` (bot wall) | Map edge to edge, one slim floating list panel at the side, things moving on the map all the time. The "what's happening" list in A copies the slim side panel. |

## How the two directions use them
- **A "Night shift"** — Strava + Mapbox night: dark 3D city at 58° pitch, neighbourhoods as real-shaped polygons that light up when busy, slim list panel on the left (Flightradar), pop-ups anchored to the area they belong to (Felt), Citizen-style rings.
- **B "Hive"** — Snap Map intensity, but drawn as an even hex grid on a white daylight map: every hex is one block of a neighbourhood and its height is how busy it is (3D columns). UI moves to a top search bar + a bottom live ticker; the peek is a side card, not a popover.
