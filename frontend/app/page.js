"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { getTimeline, triggerIngest, getIngestStatus } from "@/lib/api";
import Timeline from "@/components/Timeline";
import ClusterDrawer from "@/components/ClusterDrawer";

const SOURCES = [
  { id: "bbc", name: "BBC" },
  { id: "npr", name: "NPR" },
  { id: "guardian", name: "The Guardian" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Home() {
  const [clusters, setClusters] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(() => new Set(SOURCES.map((s) => s.id)));
  const [selectedId, setSelectedId] = useState(null);
  const [refresh, setRefresh] = useState({ phase: "idle", message: "" });
  const runningRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    getTimeline()
      .then((d) => setClusters(d.clusters))
      .catch((e) => setError(e.message));
  }, []);

  const counts = useMemo(() => {
    const out = {};
    (clusters || []).forEach((c) =>
      c.points.forEach((p) => {
        out[p.source] = (out[p.source] || 0) + 1;
      })
    );
    return out;
  }, [clusters]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const toggle = (id) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshData = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRefresh({ phase: "running", message: "Starting refresh" });
    try {
      const { jobId } = await triggerIngest();
      const started = Date.now();
      while (aliveRef.current) {
        await sleep(2000);
        const job = await getIngestStatus(jobId);
        if (job.status === "completed") {
          const d = await getTimeline();
          setClusters(d.clusters);
          setError(null);
          setSelectedId(null); // cluster ids change after re-clustering
          setRefresh({
            phase: "done",
            message:
              job.articles_added === 0
                ? "Already up to date"
                : `Added ${job.articles_added} new ${job.articles_added === 1 ? "article" : "articles"}`,
          });
          break;
        }
        if (job.status === "failed") {
          setRefresh({ phase: "error", message: job.error || "The refresh failed" });
          break;
        }
        if (Date.now() - started > 6 * 60 * 1000) {
          setRefresh({ phase: "error", message: "The refresh is taking too long. Try again." });
          break;
        }
        setRefresh({
          phase: "running",
          message: job.status === "queued" ? "Starting refresh" : "Reading feeds and grouping stories",
        });
      }
    } catch (e) {
      setRefresh({ phase: "error", message: e.message });
    } finally {
      runningRef.current = false;
    }
  };

  const busy = refresh.phase === "running";

  return (
    <>
      <header className="masthead">
        <div>
          <h1>News Pulse</h1>
          <p>
            {clusters
              ? `${clusters.length} developing stories from ${total} articles`
              : "Loading stories"}
          </p>
        </div>
        <div className="tools">
          <div className="chips" role="group" aria-label="News sources">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className="chip"
                aria-pressed={active.has(s.id)}
                onClick={() => toggle(s.id)}
                style={{ "--c": `var(--${s.id})` }}
              >
                <span className="dot" />
                {s.name}
                <span className="chip-count">{counts[s.id] || 0}</span>
              </button>
            ))}
          </div>
          <div className="tools-row">
            <p className={`refresh-note${refresh.phase === "error" ? " error" : ""}`} role="status">
              {refresh.message}
            </p>
            <button className="refresh" onClick={refreshData} disabled={busy}>
              {busy ? "Refreshing..." : "Refresh data"}
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <p className="status error">
          Can't reach the API ({error}). Start the backend with <code>node server.js</code> in{" "}
          <code>backend/</code> and reload.
        </p>
      ) : !clusters ? (
        <p className="status">Loading stories...</p>
      ) : (
        <Timeline
          clusters={clusters}
          active={active}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <ClusterDrawer
        clusterId={selectedId}
        sources={Array.from(active)}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}