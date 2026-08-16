# AreaHunt

**Live: https://areahunt.onrender.com**

Most job boards show you what's advertised. AreaHunt shows you what's *there*.

Draw an area on a map. The backend finds every organisation inside it, works out
whether they're hiring, pulls their live openings from whichever applicant
tracking system they use, and tracks each posting over time so you can tell a
fresh role from one that's been sitting there for three months.

Built and run solo. Node.js, Express, PostgreSQL, Leaflet, deployed on Render.

---

## Why it exists

The visible job market is a fraction of the real one. Plenty of organisations
are hiring without ever appearing in a search you'd think to run, either because
the role sits only on their own careers page, or because the ATS they use isn't
indexed anywhere you'd look. Geography is the filter people actually care about
and the one no board handles well.

So the question the product answers is: *who is hiring within this shape I drew,
right now, and is that listing real?*

---

## What it does

### Discovery

A drawn area is split into a grid of cells before querying Google Places, because
the API caps results per query. Grid size, pages per query and request concurrency
are all tunable at runtime so coverage can be traded against API cost deliberately
rather than discovered on a bill.

Each discovered organisation is then deep-scanned: website fetched, careers page
located, contact email extracted, ATS detected, team information looked up.

### Job sources

Postings are pulled from eleven sources, including Workday, Greenhouse, Lever,
JobAdder, BambooHR, SmartRecruiters and direct careers pages, plus aggregator
search across Seek, Indeed, LinkedIn and Jora.

Every source structures its data differently. The integration layer normalises
inconsistent third-party schemas into one internal model, so the rest of the
system never knows or cares where a posting came from.

### Posting lifecycle

Each listing carries first-seen, removal and repost detection. This is what
separates a live role from a ghost listing: a posting that vanishes and reappears
monthly is telling you something, and so is one that has been continuously open
since March.

### Scoring

- **Job quality and scam detection.** Every posting is scored and banded, so
  obviously fraudulent or content-free listings surface as such rather than
  sitting alongside real ones.
- **Semantic matching.** Paste a profile and the matcher ranks the indexed corpus
  by meaning overlap rather than keyword equality. The default engine is local
  TF-IDF, with no external dependency and no key required. Neural embeddings and
  an LLM reasoning layer are both optional upgrades enabled by configuration.
- **Role fit scoring** against a stored profile, with generated correspondence and
  server-side PDF export.

### Operator console

An admin surface covering usage and pipeline analytics, data completeness
measurement (what share of scanned organisations actually have usable contact or
job data), per-source breakdown, and user management.

Two parts worth calling out:

- **Scan tuning applies live, without a restart.** Grid size, pages per query,
  concurrency and deep-scan coverage are all editable at runtime.
- **External API calls run against a daily budget.** A heavy day fails at a known
  cost instead of quietly draining the account, which is the failure mode that
  actually bites when a scan pipeline is left running.

Every administrative action is written to an audit log with the requesting IP.

---

## Running it

Node.js 20+, PostgreSQL.

```bash
git clone <this repo>
npm install
cp .env.example .env   # fill in the keys below
npm start
```

| Key | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_MAPS_API_KEY` | Places API (New). Required for discovery |
| `SERPER_API_KEY` | Aggregator search and team lookup |
| `EMBEDDINGS_PROVIDER` | Optional. Enables neural embeddings for matching |
| `ANTHROPIC_API_KEY` | Optional. Enables the LLM reasoning layer |

Runtime scan parameters live in the admin console rather than in `.env`, so they
can be changed against a running system.

---

## Production notes

Deployed on Render's free tier, which has been useful precisely because it's
constrained. Two incidents worth documenting:

**Out-of-memory restart loop on a 512 MB instance.** Parallel deep-scans were
holding fetched page content longer than necessary, and under a wide scan the
instance would OOM, restart, resume the same scan and OOM again. Fixed by bounding
concurrency and releasing response bodies rather than accumulating them, with the
deep-scan parallelism made tunable so the ceiling is explicit rather than implicit.

**Connection pooler poisoning.** Under specific failure conditions, connections
were returned to the pool in an unusable state, so the pool gradually filled with
dead connections until every query failed. Fixed by correcting the release path on
the error branch and validating connections on checkout.

Also in place: session authentication with email verification, continuous
integration, automated database backups, error tracking, uptime monitoring, and
HMAC pseudonymisation for opt-in data export so exported records can be analysed
without carrying identifiers.

---

## Known limits

- **Admin access is a single shared password, not per-admin accounts.** The audit
  log therefore records what happened and from where, but not who. Fine for one
  operator; the first thing to change for more.
- **Email discovery is heuristic.** Some organisations publish only a contact
  form, in which case the app says so rather than guessing.
- **Job parsing falls back to scraping.** Where no known ATS is detected, titles
  are read off the careers page directly. That handles most cases and fails on
  heavily client-rendered pages.
- **Data completeness varies by area.** Coverage of small businesses is much
  thinner outside dense commercial districts, which the completeness metrics in
  the console make visible rather than hiding.

---

## Build note

Written with AI assistance. The problem definition, data model, integration
design, tuning decisions and the incident diagnoses above are mine.
