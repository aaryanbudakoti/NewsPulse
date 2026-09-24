const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const qs = (sources) =>
  sources ? `?sources=${encodeURIComponent(sources.join(","))}` : "";

export const getTimeline = (sources) => request(`/timeline${qs(sources)}`);
export const getCluster = (id, sources) => request(`/clusters/${id}${qs(sources)}`);
export const triggerIngest = () => request("/ingest/trigger", { method: "POST" });
export const getIngestStatus = (jobId) => request(`/ingest/status/${jobId}`);