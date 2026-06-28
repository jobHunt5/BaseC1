# AreaHunt

Scan a section of a map, find the companies that work there, pull their
careers email + job listings, and keep a manual checklist of jobs you've
applied to.

Built on top of the `job-area-scanner.html` mockup — the same look and feel,
but backed by a real Node/Express API that talks to Google Places (or
OpenStreetMap) and crawls company websites for careers info.

---

## What it does

1. **Draw an area on the map** (Leaflet, dark CartoDB tiles).
2. The backend asks a **places provider** for every business inside that
   bounding box.
3. For each business it then:
   - fetches the company website,
   - finds a careers / jobs page,
   - extracts a careers email (prefers `careers@`, `jobs@`, `hr@`,
     `talent@`, `recruiting@`),
   - detects whether they use a known **ATS** (Greenhouse, Lever, Workable,
     Ashby) and if so pulls real, current job postings,
   - falls back to scraping job titles off the careers page when no ATS is
     detected,
   - classifies the company into `design / dev / ai / marketing` so your
     skill filters work.
4. Everything is stored in **SQLite** so you can come back later — your
   notes, ratings, "saved", "applied" status, and per-job application
   checkboxes are all persisted.
5. **No auto-apply.** As you asked, applications stay manual. The app just
   gives you the careers page link / email and a checkbox to tick when
   you've done it.

---

## Setup

You need **Node.js 20+**.

```bash
cd /Users/basilsunny/Movies/JOB
npm install
cp .env.example .env
npm start
```

Then open <http://localhost:5174>.

---

## Picking a places provider

This is the one important decision. Edit `.env`:

```env
PLACES_PROVIDER=osm        # or "google"
GOOGLE_MAPS_API_KEY=...
```

### Option A — OpenStreetMap (default, free, no key)

Uses the public [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API).
No setup, just run. **Caveat:** OSM's small-business coverage is patchy
outside major cities, so you'll see fewer companies than what Google Maps
shows.

### Option B — Google Places API (recommended)

Best data by a long shot — every business that appears on Google Maps is
fair game.

1. Go to <https://console.cloud.google.com/>
2. Create a project (or reuse one).
3. **APIs & Services → Library** → enable:
   - **Places API (New)** — this is the only one this app uses.
   - (The search bar geocoding uses free OpenStreetMap Nominatim, so you
     do **not** need to enable Geocoding API.)
4. **APIs & Services → Credentials** → **Create credentials → API key**.
   - For safety, restrict the key to only Places API (New) and
     (optionally) to your own IP.
5. Paste it into `.env`:

   ```env
   PLACES_PROVIDER=google
   GOOGLE_MAPS_API_KEY=AIzaSy...
   ```

Google gives every account a **$200/month credit** for Maps Platform usage,
which equals thousands of scans for a personal job hunt — you almost
certainly won't pay anything.

> **About "just scraping Google Maps":** scraping `maps.google.com` directly
> violates Google's Terms of Service and the page is heavily JS-rendered so
> it breaks constantly. The Places API is the official, stable way to do
> exactly this and is what this app uses.

---

## How to use the UI

| Action | What it does |
| --- | --- |
| **🔍 Search bar** | Geocodes an address/suburb and centers the map. |
| **✦ Draw area** | Toggles draw mode — click and drag on the map to select. |
| **⚡ Scan companies** | Hits `POST /api/scan` for that bounding box. |
| **Sidebar filter pills** | Show only Design / Dev / AI / Marketing companies. |
| **All / Saved / Applied tabs** | Filter the list by your status. |
| **Click a company** | Opens the detail panel with website, email, careers page, jobs, notes, rating. |
| **☑ next to each job** | Mark *that specific job* as applied. |
| **Mark applied / Save / ✕** | Status applies to the whole company. |
| **↻ Refresh** (in detail panel) | Re-pulls the jobs list for that company. |

A scan over a busy city block typically takes **20–40 seconds** because the
backend is fetching dozens of company websites in parallel.

---

## API

The frontend is just an HTML/JS app served by the backend, so you can call
the same API from anywhere (curl, scripts, another app).

| Method | Path | Body / Query | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | Returns provider and key status. |
| `POST` | `/api/scan` | `{south,west,north,east}` | Runs full scan pipeline. |
| `GET` | `/api/companies` | — | All companies you've ever scanned. |
| `GET` | `/api/companies/in-bounds` | `?bbox=s,w,n,e` | Already-known companies in bbox (no rescan). |
| `GET` | `/api/companies/:id` | — | One company + its jobs. |
| `PATCH` | `/api/companies/:id` | `{status?, notes?, user_rating?}` | Update your tracking fields. |
| `POST` | `/api/companies/:id/refresh-jobs` | — | Re-fetch jobs only. |
| `PATCH` | `/api/jobs/:id` | `{applied: true\|false}` | Tick/untick a specific job. |

Example:

```bash
curl -s http://localhost:5174/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"south":-37.82,"west":144.95,"north":-37.81,"east":144.97}' | jq
```

---

## Tunables in `.env`

| Key | Default | Meaning |
| --- | --- | --- |
| `PORT` | `5174` | Server port |
| `PLACES_PROVIDER` | `osm` | `osm` or `google` |
| `GOOGLE_MAPS_API_KEY` | — | Required when provider is `google` |
| `ENRICH_LIMIT` | `25` | Max companies to enrich per scan |
| `ENRICH_TIMEOUT_MS` | `8000` | Per-request timeout when crawling sites |
| `ENRICH_USER_AGENT` | `AreaHuntBot/1.0` | Sent when fetching company sites |

---

## File layout

```
.
├── package.json
├── .env.example
├── README.md
├── public/
│   ├── index.html         # Front end (same look as the original mockup)
│   ├── app.js             # All UI logic; talks to /api/*
│   └── styles.css
└── server/
    ├── index.js           # Express bootstrap
    ├── db.js              # SQLite (better-sqlite3) schema + queries
    ├── data/              # SQLite file lives here (gitignored)
    ├── routes/
    │   ├── scan.js        # POST /api/scan
    │   └── companies.js   # /api/companies + /api/jobs CRUD
    └── services/
        ├── placesService.js     # Google Places + OSM Overpass
        ├── enrichService.js     # Website → careers page + email
        ├── jobsService.js       # ATS detection + job parsing
        └── classifyService.js   # Heuristic category/skill tagging
```

---

## Known limits & next steps

- **Email discovery is heuristic.** Some companies only list a contact form
  (no email anywhere on the site) — the app shows "No careers email found"
  in that case and points you at the careers page.
- **Job parsing fallback is rough.** When a company doesn't use one of the
  four supported ATSes, we scrape job titles off the careers page itself.
  That works ~70% of the time; for fancy SPA careers pages you may need to
  click the careers link manually.
- **No login.** Single-user, local-only. If you ever want to share it,
  wrap the API in basic auth.
- **No background re-scans.** If you want the app to re-check jobs daily,
  point cron at `POST /api/companies/:id/refresh-jobs`.

Possible easy follow-ups if you want them later:

- Add more ATSes (BambooHR, SmartRecruiters, JazzHR, Personio, Recruitee).
- Add LinkedIn company-page resolution via a third-party API.
- Export your "applied" list to CSV.
- Add a CV/skill text field and have the backend rank job titles by
  similarity to your CV.
