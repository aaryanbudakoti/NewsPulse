# News Pulse: Topic-Clustered News Timeline

LIVE LINK : https://news-pulse-lime.vercel.app/
<br>


<img width="1898" height="965" alt="Screenshot 2026-09-24 221758" src="https://github.com/user-attachments/assets/156e61c6-41fb-41a8-ac67-347dc12257fb" />

Ingests BBC, NPR and Guardian RSS feeds, groups articles into story clusters with TF-IDF, and plots each story on a timeline.

## Structure
- `scraper/` Python: RSS ingestion, article text extraction, TF-IDF clustering, `run_pipeline.py` entry point
- `backend/` Node.js + Express API; spawns the Python pipeline via `child_process`
- `frontend/` Next.js (React) timeline UI
- `schema.sql` Postgres schema (Supabase)

## Setup
1. **Database:** create a Supabase project, run `schema.sql` in the SQL Editor, and copy the Session pooler connection string.
2. **Scraper:**
```
   cd scraper
   python -m venv venv
   venv\Scripts\activate        # Mac/Linux: source venv/bin/activate
   pip install -r requirements.txt
   copy .env.example .env       # then set DATABASE_URL
   python run_pipeline.py       # first ingest + clustering
```
3. **Backend:**
```
   cd backend
   npm install
   copy .env.example .env       # set DATABASE_URL
   node server.js               # http://localhost:4000
```
   The backend runs the scraper with `scraper/venv`. If your Python lives elsewhere, set `PYTHON_BIN` in `backend/.env`.
4. **Frontend:**
```
   cd frontend
   npm install
   copy .env.example .env.local
   npm run dev                  # http://localhost:3000
```

## API
| Endpoint | Description |
|---|---|
| `GET /clusters?sources=bbc,npr` | Clusters with counts, sources and time span |
| `GET /clusters/:id?sources=...` | One cluster with its articles |
| `GET /timeline?sources=...` | Clusters plus one point per article |
| `POST /ingest/trigger` | Creates a job and runs the pipeline; returns `jobId` (reuses a job already running) |
| `GET /ingest/status/:jobId` | `queued`, `running`, `completed` or `failed`, with articles added and any error |

## How it works
- **Ingestion:** feeds are fetched with timeouts. Article text comes from the RSS content when it is long enough, otherwise from the page via trafilatura (8 parallel fetches, 20 s hard limit, 2 MB cap). NPR pages are read from `text.npr.org`. If extraction fails, the RSS summary is stored. Inserts use `ON CONFLICT (url) DO NOTHING`, so re-runs are safe.
- **Clustering:** TF-IDF (unigrams and bigrams, titles weighted 3x) and agglomerative clustering on cosine distance with a fixed threshold, so the number of clusters is not chosen up front. Clusters with one article are dropped. Labels use keywords shared by at least two articles in the cluster, preferring words that appear in headlines, with generic news words filtered out. Clusters are rebuilt on every run.
- **Jobs:** the pipeline updates its own row in `ingest_jobs`. Node marks the job failed if Python crashes or exceeds 5 minutes, so the UI never polls forever.
- **Frontend:** the timeline shows the last 24 hours. Source toggles filter in the browser; the detail drawer calls `/clusters/:id`. Refresh polls job status every 2 seconds.

## Trade-offs and limitations
- The deployed Render backend runs Node only; it has no Python runtime, so `POST /ingest/trigger` will fail there. The full pipeline (ingest, extraction, clustering) works end-to-end locally, as shown in the setup steps above.
- Clusters are rebuilt from scratch on each run, so cluster ids change and story identity is not tracked between runs.
- Pure TF-IDF cannot match stories with no shared vocabulary; embeddings would do better.
- The Postgres role used by the backend bypasses RLS. RLS is enabled with no policies, so the public Supabase API cannot read the tables.
- No authentication on the ingest endpoint. It is rate-limited only by reusing an active job.
