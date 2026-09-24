"use client";
import { useMemo } from "react";

const HOUR = 3600000;
const WINDOW = 24 * HOUR;
const tms = (iso) => new Date(iso).getTime();
const NAMES = { bbc: "BBC", npr: "NPR", guardian: "The Guardian" };

function makeTicks(t0, t1) {
  const spanH = (t1 - t0) / HOUR;
  const step = [1, 2, 3, 4, 6, 12, 24].find((s) => spanH / s <= 9) || 24;
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  while (d.getTime() < t0 || d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
  const ticks = [];
  for (; d.getTime() <= t1; d.setHours(d.getHours() + step)) {
    const dt = new Date(d.getTime());
    const isDay = dt.getHours() === 0;
    ticks.push({
      time: dt.getTime(),
      day: isDay,
      label: isDay
        ? dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
        : dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }),
    });
  }
  return ticks;
}

export default function Timeline({ clusters, active, selectedId, onSelect }) {
  const view = useMemo(() => {
    const all = clusters.flatMap((c) => c.points.map((p) => tms(p.published_at)));
    if (all.length === 0) return null;

    const now = Date.now();
    const latest = Math.max(Math.max(...all), now);
    const t0 = latest - WINDOW;
    const t1 = latest + HOUR;
    const pct = (x) => ((x - t0) / (t1 - t0)) * 100;

    const rows = clusters
      .map((c) => {
                const pts = c.points.filter(
          (p) => active.has(p.source) && tms(p.published_at) >= t0
        );
        const times = pts.map((p) => tms(p.published_at));
        return {
          id: c.id,
          label: c.label,
          count: pts.length,
          end: Math.max(...times),
          startPct: pct(Math.min(...times)),
          endPct: pct(Math.max(...times)),
          pts: pts.map((p) => ({
            id: p.article_id,
            source: p.source,
            pct: pct(tms(p.published_at)),
            when: new Date(p.published_at).toLocaleString(),
          })),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.end - a.end);

    const ticks = makeTicks(t0, t1).map((t) => ({ ...t, pct: pct(t.time) }));
    const nowPct = pct(now);
    return { rows, ticks, nowPct: nowPct > 0 && nowPct < 100 ? nowPct : null };
  }, [clusters, active]);

  if (!view) return <p className="status">No stories yet. Data will appear after the first ingest.</p>;
  if (view.rows.length === 0)
    return <p className="status">No stories for the selected sources. Turn a source back on above.</p>;

  return (
    <div className="tl">
      <div className="axis">
        <div className="axis-inner">
          {view.ticks.map((t) => (
            <span key={t.time} className={`tick-label${t.day ? " day" : ""}`} style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
          {view.nowPct !== null && (
            <span className="now-tag" style={{ left: `${view.nowPct}%` }}>now</span>
          )}
        </div>
      </div>

      <div className="plot">
        {view.ticks.map((t) => (
          <div key={t.time} className={`gridline${t.day ? " day" : ""}`} style={{ left: `${t.pct}%` }} />
        ))}
        {view.nowPct !== null && <div className="nowline" style={{ left: `${view.nowPct}%` }} />}

        {view.rows.map((r) => {
          const flip = r.startPct > 50;
          const labelStyle = flip
            ? { right: `${100 - r.endPct}%`, textAlign: "right" }
            : { left: `${r.startPct}%` };
          return (
            <button
              key={r.id}
              className="row"
              aria-pressed={selectedId === r.id}
              aria-label={`${r.label}, ${r.count} articles`}
              onClick={() => onSelect(r.id)}
            >
              <span className="row-label" style={labelStyle}>
                {r.label}
                <span className="row-count">{r.count} {r.count === 1 ? "article" : "articles"}</span>
              </span>
              <span className="row-track">
                <span
                  className="row-bar"
                  style={{ left: `${r.startPct}%`, width: `${r.endPct - r.startPct}%` }}
                />
                {r.pts.map((p) => (
                  <span
                    key={p.id}
                    className="pt"
                    title={`${NAMES[p.source]}, ${p.when}`}
                    style={{ left: `${p.pct}%`, "--c": `var(--${p.source})` }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}