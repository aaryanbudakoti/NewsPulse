require("dotenv").config();
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const VALID_SOURCES = ["bbc", "npr", "guardian"];

// undefined -> null (no filter); "bbc,npr" -> ["bbc","npr"]; "" -> [] (matches nothing)
function parseSources(raw) {
  if (raw === undefined) return null;
  return String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_SOURCES.includes(s));
}

const CLUSTER_SUMMARY_SQL = `
  select c.id, c.label, c.keywords,
         count(a.id)::int as article_count,
         array_agg(distinct a.source order by a.source) as sources,
         min(a.published_at) as first_published_at,
         max(a.published_at) as last_published_at
  from clusters c
  join articles a on a.cluster_id = c.id
  where ($1::text[] is null or a.source = any($1::text[]))
  group by c.id
  order by max(a.published_at) desc nulls last
`;

app.get("/", (req, res) => res.json({ name: "News Pulse API", status: "ok" }));

app.get("/health", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "select (select count(*) from articles)::int as articles, (select count(*) from clusters)::int as clusters"
    );
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// List clusters
app.get("/clusters", async (req, res) => {
  try {
    const sources = parseSources(req.query.sources);
    const { rows } = await pool.query(CLUSTER_SUMMARY_SQL, [sources]);
    res.json({ clusters: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load clusters" });
  }
});

// Cluster detail + its articles
app.get("/clusters/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid cluster id" });
  }
  try {
    const sources = parseSources(req.query.sources);
    const clusterRes = await pool.query(
      "select id, label, keywords from clusters where id = $1",
      [id]
    );
    if (clusterRes.rows.length === 0) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    const articlesRes = await pool.query(
      `select id, source, title, url, summary, published_at
       from articles
       where cluster_id = $1
         and ($2::text[] is null or source = any($2::text[]))
       order by published_at desc nulls last`,
      [id, sources]
    );
    res.json({ ...clusterRes.rows[0], articles: articlesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load cluster" });
  }
});

// Timeline: each cluster with its time span and one point per article
app.get("/timeline", async (req, res) => {
  try {
    const sources = parseSources(req.query.sources);
    const { rows: clusters } = await pool.query(CLUSTER_SUMMARY_SQL, [sources]);
    const { rows: points } = await pool.query(
      `select cluster_id, id, source, published_at
       from articles
       where cluster_id is not null
         and published_at is not null
         and ($1::text[] is null or source = any($1::text[]))
       order by published_at asc`,
      [sources]
    );
    const byCluster = new Map();
    for (const p of points) {
      if (!byCluster.has(p.cluster_id)) byCluster.set(p.cluster_id, []);
      byCluster.get(p.cluster_id).push({
        article_id: p.id,
        source: p.source,
        published_at: p.published_at,
      });
    }
    res.json({
      clusters: clusters.map((c) => ({ ...c, points: byCluster.get(c.id) || [] })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load timeline" });
  }
});

// ---------- Ingestion ----------
const SCRAPER_DIR = path.join(__dirname, "..", "scraper");
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const win = path.join(SCRAPER_DIR, "venv", "Scripts", "python.exe");
  const nix = path.join(SCRAPER_DIR, "venv", "bin", "python");
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return process.platform === "win32" ? "python" : "python3";
}

async function failJob(jobId, message) {
  try {
    await pool.query(
      `update ingest_jobs
       set status = 'failed', error = $2, finished_at = now()
       where id = $1::uuid and status in ('queued', 'running')`,
      [jobId, String(message).slice(0, 500)]
    );
  } catch (err) {
    console.error("failJob error:", err);
  }
}

function runPipeline(jobId) {
  let stderrTail = "";
  let finished = false;

  const child = spawn(pythonBin(), ["run_pipeline.py", jobId], {
    cwd: SCRAPER_DIR,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  const timer = setTimeout(() => {
    if (!finished) {
      child.kill();
      failJob(jobId, "Pipeline timed out");
    }
  }, JOB_TIMEOUT_MS);

  child.stdout.on("data", (d) => process.stdout.write(`[pipeline] ${d}`));
  child.stderr.on("data", (d) => {
    process.stderr.write(`[pipeline:err] ${d}`);
    stderrTail = (stderrTail + d).slice(-500);
  });

  child.on("error", (err) => {
    finished = true;
    clearTimeout(timer);
    failJob(jobId, `Could not start pipeline: ${err.message}`);
  });

  child.on("close", (code) => {
    finished = true;
    clearTimeout(timer);
    if (code !== 0) {
      // no-op if Python already marked the job failed itself
      failJob(jobId, stderrTail || `Pipeline exited with code ${code}`);
    }
  });
}

app.post("/ingest/trigger", async (req, res) => {
  try {
    const active = await pool.query(
      `select id, status from ingest_jobs
       where status in ('queued', 'running')
         and started_at > now() - interval '10 minutes'
       order by started_at desc limit 1`
    );
    if (active.rows.length > 0) {
      return res.json({
        jobId: active.rows[0].id,
        status: active.rows[0].status,
        alreadyRunning: true,
      });
    }
    const { rows } = await pool.query(
      "insert into ingest_jobs (status) values ('queued') returning id"
    );
    const jobId = rows[0].id;
    runPipeline(jobId);
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to trigger ingestion" });
  }
});

app.get("/ingest/status/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId)) {
    return res.status(400).json({ error: "Invalid job id" });
  }
  try {
    const { rows } = await pool.query(
      `select id, status, articles_added, error, started_at, finished_at
       from ingest_jobs where id = $1::uuid`,
      [jobId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Job not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load job status" });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));