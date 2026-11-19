# Circle — Nexconn Build Challenge 2026 (working name)

Deadline: Sun 2026-11-22 23:59 IST. Plan to submit by evening.
Rules: https://reskilll.com/hack/nexconn/rules (Chat SDK required; web OK).
Track: Social & Community (fits Open Innovation too).

## The loop (Boss man, 2026-11-19)
"tap the area, build your neighbourhood, host events and chat with your people in vicinity"

1. Map (MapLibre + free OSM tiles, no key). Neighbourhood areas you can tap.
2. Tap an empty area -> "Build your neighbourhood": name it, you are the founder.
3. Tap an existing one -> join its chat room (Nexconn Chat SDK / Chat UI).
4. Host an event: title, time, place -> pin on the map + post in the room.
5. "What's happening": the map shows live activity in MY area and in other areas
   (upcoming events, how busy each room is right now, latest posts). Tap any area to peek.
6. Privacy (Boss man, 2026-11-19): "my exact location wont be shared only one area where i am".
   The phone finds your spot, turns it into an area name ON THE DEVICE, and sends only the area.
   Others see "someone in <area>", never a dot. Your home area is your area.

## Out (for now)
- Clubhouse-style live voice rooms (Call SDK) — stretch only if day 3 has spare hours.
- Outside event data, identity/address checks, marketplace, polls.

## Submission checklist
- [ ] PDF write-up (why, problem, SDK features, App Key)
- [ ] Demo video (public link)
- [ ] Live URL
- [ ] Public GitHub repo (review for secrets before push)
- [ ] Traction: seed 5-10 real areas, invite friends

## Plan
- Nov 19: scope locked; A/B/C screen previews -> Boss man picks.
- Nov 20: Boss man makes Nexconn account + App Key. Map + chat room working.
- Nov 21: build-neighbourhood + events + deploy.
- Nov 22: seed users, video, PDF, repo, submit.

## Design (2026-11-19, round 2)
Boss man rejected all round-1 looks: "none it should be a map and make it for a website so its easy to develop".
Website-first, full-screen real map, small floating panels, chat docked right. Brief: design/r2/BRIEF.md
- Name: Boss man said "nearby" (2026-11-19) — likely the product name (from Astra r2 mock). Confirm.

## 3D decision (2026-11-19)
Boss man: "just use google earth or something else for 3d views of places because this has to be real and working".
=> Google Maps JavaScript API 3D Maps (Map3DElement): photorealistic 3D, fly-to camera, 3D markers + popovers, polygons.
Needs a Google Maps key from Boss man (Google "Maps Demo Key" = no card). Photoreal meshes only in selected metros;
elsewhere (maybe Indian cities) it falls back to satellite on terrain -> pick a demo city with full coverage. Stylised r3 stopped.

## 3D decision v2 (2026-11-19) — SUPERSEDES "3D decision"
Boss man: "yeah i am okay with that cesimjs or anything else build with opensoruce and show me".
=> Open source only: MapLibre GL JS + OpenFreeMap (keyless) + deck.gl for in-map effects. No Google key, no Cesium ion.
Free height data for terrain if cheap. Dark game look from design/r2/claude/A. Google demo-key terms were NOT accepted.
