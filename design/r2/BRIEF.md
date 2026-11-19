# Round 2 brief — website, map is the whole screen

Owner feedback on round 1 (verbatim): "none it should be a map and make it for a website so its easy to develop"

Owner, more (verbatim): "a person opens up the website the whole screen is a cool map"
and "things keep pooping up like pokemon go"

## The feel
- The map ITSELF is the hero and must look COOL: a custom-styled map (your own MapLibre style JSON:
  colours, roads, water, buildings, maybe 3D building extrusions and a tilted pitch), not the default OSM look.
- Live things keep POPPING UP on the map, Pokémon-Go style mechanic (do NOT copy Pokémon Go art or characters):
  a new chat message bubbles up over its area, an event pin drops in with a bounce, "3 people joined Koramangala"
  ripples out, then each fades. Something new appears every 1-3 seconds, so the city feels alive.
- Clicking a popped-up thing opens it (peek / event / chat).

## What that means
- DESKTOP WEBSITE first: 1440x900. The real map (MapLibre + free keyless OSM style,
  e.g. https://tiles.openfreemap.org/styles/liberty) fills the WHOLE viewport, edge to edge.
- All UI floats ON the map as a few small panels. No big headers, no full-page sheets, no illustrated maps.
- Easy to develop: plain rectangles/rounded cards, one font (Google Fonts sans), one accent colour,
  standard map overlays (GeoJSON polygons for areas, simple markers for events). No hand-drawn shapes,
  no custom illustration, no tricky CSS. A dev should rebuild each screen in a day with MapLibre + a chat panel.
- The chat panel must look like a normal messenger that a stock chat UI kit can be themed into.
- Use Bengaluru for all sample data (areas: Indiranagar, Koramangala, HSR Layout, Jayanagar, Whitefield, Malleshwaram).

## Screens (desktop 1440x900 each)
1. map — the city map. Areas drawn as polygons; busy-right-now areas glow stronger; event pins;
   my area marked as an AREA ("You're in Indiranagar"), never a dot; a small "what's happening" list.
2. peek — I clicked an area: a small floating card with latest post, next event, people here now, Join button.
3. build — I clicked an empty area: small floating form "Build your neighbourhood" (name it, you're founder).
4. chat — I joined: the chat panel docks on the right (~400px), map still visible and live on the left,
   with an event card inside the chat.
Also 5. mobile — screen 1 at 390x844 (the same site, responsive: map full screen, panel becomes a bottom drawer).

## Directions
Make 2 directions (A, B) that differ in STRUCTURE (where panels sit, how the list/chat is arranged,
how areas are drawn), not just colour. Round-1 judges punished "same layout in different skins".

## Motion proof
Pop-ups must actually animate in the HTML (CSS/JS timers, fake data). Silent only: no audio, ever.
