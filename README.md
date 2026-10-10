# PLUVIA SENSE — pluvial flood watch

Real-time flood detection, citizen reporting, decision support and early warnings.
Backend: Node >= 18, **no dependencies**. Frontend: one static page (MapLibre GL), served by the backend.

## Files (all at the top level of the repository, no sub-folders)
    server.js      the backend (API, risk engine, warnings, live stream)
    index.html     the front end (3D map, wizard, operations dashboard); logos are embedded in it
    package.json   tells the host how to start the app

## Run locally
    OPS_TOKEN=choose-a-code DEVICE_KEY=choose-a-key node server.js
    # open http://localhost:3000  (camera and GPS work on localhost and on https only)

## Deploy
Upload the three files above to a GitHub repository, create a Web Service on render.com
(Build: `npm install`, Start: `node server.js`) and set the environment variables below.
GitHub Pages cannot run the backend.
Check: open `https://YOUR-APP.onrender.com/api/health`. You must see `"frontend":true`.
If it says `false`, `index.html` is missing next to `server.js` in your repository.

## How it works
1. **Citizen report.** Tap the map or use "Use my location" → 3-step wizard. A **live photo or video from the camera is
   required** (no gallery uploads; photos are stamped with time and place). Only if the camera cannot be opened can the
   reporter send without media, and that report is scored lower.
2. **Decision makers** (Operations mode, access code) get an immediate alert with the photo, the **intensity**
   (Low / Moderate / High / Critical) and a **suggested decision**, then can mark it Verified / Dispatched / Resolved.
3. **Automatic detection.** Each monitoring point reports water level and rain. The platform raises an alert, with the
   camera frame, when: the level nears the overflow threshold; the level rises fast; the level rises without rain
   (blocked drain, burst pipe, upstream release); or the on-site camera sends a detection event.
4. **Forecast warnings.** Rain forecast (Open-Meteo, hourly, fetched by the server) is scanned for intense rain
   (>= `HEAVY_MM_H` mm/h, default 8). For each episode, **schools, parents and authorities** subscribed to the area get:
   an early notice (up to 24 h ahead), a **warning about 1 hour before** with the time window, the expected road
   cut-off and when roads should reopen, and an **all-clear** once the rain has ended, the reopening time has passed
   and the sensors are calm. Pupils are told to stay at school until the all-clear. Messages in English, French, Arabic.
   The public map also shows the active warnings.

## Environment variables
| Name | Purpose |
|---|---|
| `OPS_TOKEN` | Decision makers' access code (required in production) |
| `DEVICE_KEY` | Key the sensors send in `x-device-key` |
| `DATA_DIR` | Where reports, media and subscribers are stored (use a persistent disk) |
| `HEAVY_MM_H` | Intense-rain threshold in mm/h (default 8) |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Send SMS to subscribers' phones through Twilio |
| `WEBHOOK_URL` | Each notification is POSTed here as JSON `{to:{phone,email,name},role,lang,stage,area,text}` (WhatsApp / Telegram / e-mail via Make, n8n, Zapier, your gateway) |

Without Twilio or a webhook, warnings are only recorded and shown in Operations ("Warnings sent"), marked *not sent*.

## Sensor and camera API
    curl -X POST https://YOUR-APP/api/readings \
      -H "content-type: application/json" -H "x-device-key: YOUR_DEVICE_KEY" \
      -d '{"node":"N4","level_cm":87.5,"rain_mmh":22.0,
           "event":"water_rising","frame":"data:image/jpeg;base64,..."}'
`node` is N1..N8 (edit names, coordinates and overflow thresholds `thr` in `server.js`). `event` is optional:
`water_rising`, `suspicious` or `blocked_drain` (detected by the on-site camera); `frame` is an optional JPEG (max 2 MB)
attached to the alert. Send a reading every 30-60 s (every 10 s in heavy rain). A node silent for 2 minutes falls back
to a simulation driven by live rainfall.

## Endpoints
| Method | Path | Access |
|---|---|---|
| GET | /api/state, /api/stream (SSE) | public view; add `x-ops-token` or `?token=` for full detail |
| GET | /api/weather?lat&lon | public (cached, rate-limited) |
| POST | /api/reports (+ /api/reports/:id/video) | public, rate-limited, coverage area only |
| POST | /api/subscribe, DELETE /api/subscribers/:id | public (authority role needs the ops code) |
| POST | /api/readings | sensors (`x-device-key`) |
| PATCH | /api/items/:id `{status}` | operations |
| POST | /api/sim/storm, /api/sim/forecast, /api/sim/event | operations (test buttons) |
| GET | /api/media/:file | operations |

## Notes
- Base imagery is Esri World Imagery on real terrain (not live). The live layer is animated radar (RainViewer).
- Risk levels, intensity and suggested decisions are rule-based; calibrate thresholds with ONAS / municipal data.
- Subscribers' phone numbers and e-mails are stored in `db.json`: protect the disk, and comply with local data-protection law.
- Use https in production; rotate `OPS_TOKEN` if it leaks. Next: user accounts, a database, delivery receipts.
