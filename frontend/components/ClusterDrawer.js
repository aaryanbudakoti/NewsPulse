"use client";
import { useEffect, useRef, useState } from "react";
import { getCluster } from "@/lib/api";

const NAMES = { bbc: "BBC", npr: "NPR", guardian: "The Guardian" };

const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

export default function ClusterDrawer({ clusterId, sources, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);
  const sourcesKey = sources.join(",");

  useEffect(() => {
    if (clusterId == null) return;
    let cancelled = false;
    setData(null);
    setError(null);
    getCluster(clusterId, sourcesKey ? sourcesKey.split(",") : [])
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [clusterId, sourcesKey]);

  useEffect(() => {
    if (clusterId == null) return;
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clusterId, onClose]);

  if (clusterId == null) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Story details">
        <div className="drawer-head">
          <div>
            <h2>{data ? data.label : "Loading story"}</h2>
            {data && (
              <p>
                {data.articles.length} {data.articles.length === 1 ? "article" : "articles"}
              </p>
            )}
          </div>
          <button ref={closeRef} className="drawer-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          {error && <p className="status error">Couldn't load this story ({error}). Close and try again.</p>}
          {!data && !error && <p className="status">Loading articles...</p>}
          {data && data.articles.length === 0 && (
            <p className="status">No articles from the selected sources. Turn a source back on.</p>
          )}
          {data && data.articles.length > 0 && (
            <ul className="feed">
              {data.articles.map((a) => (
                <li key={a.id} className="art" style={{ "--c": `var(--${a.source})` }}>
                  <div className="art-meta">
                    <span className="dot" />
                    {NAMES[a.source]}
                    <time dateTime={a.published_at}>{fmt(a.published_at)}</time>
                  </div>
                  <a className="art-title" href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.title}
                  </a>
                  {a.summary && <p className="art-sum">{a.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}