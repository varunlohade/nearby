# Design brief — map-first neighbourhood chat web app

Read SCOPE.md in this folder first. Work ONLY inside this folder. Do not read any other folder.

## Goal
3 clearly different visual directions (A, B, C) for the app, as static HTML/CSS mockups.
Most people use it on a phone; it is a web app.

## Screens per direction (phone, 390px wide x 844px tall)
1. map.html — live map of a city: neighbourhood areas you can tap. "What's happening": my area
   highlighted as an AREA ("you are here", never a dot), other areas show how busy their room is
   right now (glow/pulse), event pins, a latest-post peek for one tapped area.
2. build.html — "Build your neighbourhood" sheet after tapping an empty area (name it, you are founder).
3. chat.html — that area's chat room, a normal clean messenger with an event card in the stream.
   People appear as "someone in <area>" or a first name, never their exact spot.
Plus desktop.html — the map screen at 1440x900.

## Rules
- First write INSPIRATION.md: 5-6 real, award-level references (URL + one line on what to steal).
  Do not copy Nextdoor, Snap Map, Zenly or Clubhouse.
- A, B, C must differ in palette, type, how areas are drawn and panel layout. Not three recolours.
- Map: MapLibre GL JS from unpkg/cdnjs with a free keyless style
  (https://tiles.openfreemap.org/styles/liberty or similar), or a hand-drawn SVG map if that fails.
- No real people's photos, no brand logos, no audio.
- File layout: A/map.html A/build.html A/chat.html A/desktop.html, same for B and C.
- Each file must be self-contained (inline CSS) apart from CDN scripts and Google Fonts.
