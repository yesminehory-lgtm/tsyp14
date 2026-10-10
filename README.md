# PLUVIA SENSE - urban pluvial flood platform (TSYP14), Greater Tunis

**Run:** `node server.js` (Node 18+, no npm install) then open http://localhost:3000. In a second terminal: `node simulate.js` to play a storm.

**What it does**
- 3D satellite map of Greater Tunis (Esri World Imagery + AWS terrain + OpenFreeMap 3D buildings, via MapLibre GL). Needs internet for tiles.
- Citizens tap the map or press *Use my location* -> wizard: type, severity, description, photos/video from device, or live camera capture / 8 s recording -> report is scored (0-100) for credibility (media, GPS, nearby sensor alert).
- Hardware nodes POST readings; the back end computes alert level, risk score, a 30-minute water-level trend and time-to-critical; a snapshot sent at warning level creates an automatic report.
- *Control room* tab: live alerts with suggested actions, report list with status workflow (acknowledged / dispatched / resolved), real forecast (Open-Meteo).

**Node API** (header `x-node-key`, default `demo-key`, set `NODE_KEY`):
`curl -X POST localhost:3000/api/readings -H "x-node-key: demo-key" -H "Content-Type: application/json" -d '{"id":"PS-01","rain":32,"wl":28,"battery":90}'`
Optional fields: `lat`, `lon`, `ts` (ms), `snapshot` (data URL of a camera frame).

**Be aware**
- Satellite imagery is recent, not live video; the live parts are sensors, reports and rainfall. Check Esri/OpenFreeMap terms (or use your own key) before public deployment.
- Alert thresholds (rain 10/20/40 mm/h, water 15/30/50 cm) and node positions are illustrative: calibrate with INM data and real sites.
- Prototype security only: add authentication for the control room, HTTPS (required for camera/GPS off localhost) and a real database for production.
