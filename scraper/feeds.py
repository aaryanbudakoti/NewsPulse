import html
import re
from datetime import datetime, timezone

import feedparser
import requests

FEEDS = {
    "bbc": "https://feeds.bbci.co.uk/news/rss.xml",
    "npr": "https://feeds.npr.org/1001/rss.xml",
    "guardian": "https://www.theguardian.com/world/rss",
}

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NewsPulseBot/1.0)"}


def clean_text(raw):
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(entry):
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc)
    return None


def fetch_source(source, url):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"[{source}] fetch failed: {e}")
        return []

    parsed = feedparser.parse(resp.content)
    items = []
    for e in parsed.entries:
        link = e.get("link")
        title = clean_text(e.get("title"))
        if not link or not title:
            continue
        items.append({
            "source": source,
            "title": title,
            "url": link.split("?")[0],
            "summary": clean_text(e.get("summary") or e.get("description")),
            "content": clean_text(e["content"][0].get("value")) if e.get("content") else "",
            "published_at": parse_date(e),
        })
    return items


def fetch_all():
    all_items = []
    for source, url in FEEDS.items():
        items = fetch_source(source, url)
        print(f"[{source}] {len(items)} entries")
        all_items.extend(items)
    return all_items


if __name__ == "__main__":
    items = fetch_all()
    print(f"\nTotal: {len(items)}")
    for it in items[:3]:
        print(it["source"], "|", it["published_at"], "|", it["title"])