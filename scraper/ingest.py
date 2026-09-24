import re
import time
from concurrent.futures import ThreadPoolExecutor

import requests
import trafilatura
from psycopg2.extras import execute_values

from db import get_conn
from feeds import fetch_all

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

MAX_BODY_CHARS = 20000
MAX_HTML_BYTES = 2_000_000
TOTAL_TIMEOUT = 20  # hard cap in seconds per page
MIN_GOOD_BODY = 500  # feed content shorter than this -> try fetching the page


def clean(s):
    return s.replace("\x00", "") if s else s


def fetch_html(url):
    deadline = time.monotonic() + TOTAL_TIMEOUT
    with requests.get(url, headers=BROWSER_HEADERS, timeout=(5, 8), stream=True) as resp:
        resp.raise_for_status()
        chunks, size = [], 0
        for chunk in resp.iter_content(65536):
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_HTML_BYTES:
                raise ValueError("page too large")
            if time.monotonic() > deadline:
                raise TimeoutError("total deadline exceeded")
        return b"".join(chunks).decode(resp.encoding or "utf-8", errors="replace")


def page_url(item):
    """NPR: use the lightweight text-only mirror, which is far easier to fetch."""
    if item["source"] == "npr":
        m = re.match(r"https?://www\.npr\.org/\d{4}/\d{2}/\d{2}/([^/]+)/", item["url"])
        if m:
            return f"https://text.npr.org/{m.group(1)}"
    return item["url"]

def get_body(item):
    """Best body text for an item. Never raises."""
    if item.get("content") and len(item["content"]) >= MIN_GOOD_BODY:
        return item["content"][:MAX_BODY_CHARS]
    try:
        html = fetch_html(page_url(item))
        text = trafilatura.extract(html, include_comments=False, include_tables=False)
        if text:
            return text[:MAX_BODY_CHARS]
    except Exception as e:
        print(f"  body fetch failed: {item['url']} ({type(e).__name__})")
    return item.get("content") or item.get("summary") or ""


def run_ingest():
    items = fetch_all()
    if not items:
        print("No feed items fetched.")
        return 0

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "select url from articles where url = any(%s)",
                ([i["url"] for i in items],),
            )
            existing = {r[0] for r in cur.fetchall()}
            new_items = [i for i in items if i["url"] not in existing]
            print(f"{len(new_items)} new articles (skipping {len(existing)} existing)")

            if not new_items:
                return 0

            with ThreadPoolExecutor(max_workers=8) as pool:
                bodies = list(pool.map(get_body, new_items))
            print("Bodies fetched, saving...")

            rows = [
                (
                    it["source"],
                    clean(it["title"]),
                    it["url"],
                    clean(it["summary"]),
                    clean(body),
                    it["published_at"],
                )
                for it, body in zip(new_items, bodies)
            ]

            inserted = execute_values(
                cur,
                "insert into articles (source, title, url, summary, body, published_at) "
                "values %s on conflict (url) do nothing returning id",
                rows,
                fetch=True,
            )
        conn.commit()
        print(f"Inserted {len(inserted)} articles")
        return len(inserted)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    run_ingest()