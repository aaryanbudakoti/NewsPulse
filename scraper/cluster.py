import re
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer

from db import get_conn

DISTANCE_THRESHOLD = 0.88  # lower = tighter/more clusters, higher = looser/fewer
MIN_CLUSTER_SIZE = 2

GENERIC = {
    "hits", "reached", "scene", "overall", "final", "team", "players", "death", "deaths",
    "company", "chief", "executive", "biggest", "plots", "plot", "win", "won", "gets", "top",
    "said", "says", "say", "new", "year", "years", "old", "man", "woman", "men", "women",
    "people", "day", "days", "week", "weeks", "time", "world", "uk", "news", "report",
    "reports", "live", "watch", "latest", "first", "last", "amid", "video", "home", "back",
    "way", "just", "like", "make", "made", "use", "used", "told", "according", "today",
    "yesterday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "npr", "bbc", "guardian", "com", "www", "http", "https", "min", "mins",
    "image", "images", "getty", "photo", "photos", "read", "click", "subscribe", "share",
    "comment", "comments", "advertisement", "ap", "reuters",
}
STOP_WORDS = list(ENGLISH_STOP_WORDS | GENERIC)
ACRONYMS = {"ai", "eu", "un", "nhs", "nato", "fbi", "cia", "gop", "tv", "gdp", "ceo", "nba", "nfl", "idf"}


def build_text(title, summary, body):
    return f"{title} {title} {title} {summary or ''} {(body or '')[:3000]}"


def pretty(term):
    return " ".join(w.upper() if w in ACRONYMS else w.capitalize() for w in term.split())


def pick_keywords(centroid, doc_counts, size, terms, titles, k=5):
    min_docs = min(2, size)
    scored = []
    for i in np.nonzero(centroid)[0]:
        if doc_counts[i] < min_docs:
            continue  # keyword must be shared by 2+ articles in this cluster
        term = str(terms[i])
        pattern = re.compile(rf"\b{re.escape(term)}\b")
        title_hits = sum(1 for t in titles if pattern.search(t))
        boost = 0.3 if title_hits == 0 else 1 + 0.75 * min(title_hits, 2)
        weight = centroid[i] * (doc_counts[i] / size) * boost
        if " " in term:
            weight *= 1.3  # prefer phrases like "los angeles"
        scored.append((weight, term))
    scored.sort(reverse=True)

    chosen, used = [], set()
    for _, term in scored:
        stems = {w[:5] for w in term.split()}
        if stems & used:
            continue  # skip near-duplicates (israel / israeli)
        chosen.append(term)
        used |= stems
        if len(chosen) == k:
            break
    return chosen


def run_clustering():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "select id, title, summary, body, published_at from articles order by id"
            )
            rows = cur.fetchall()
            if len(rows) < 2:
                print("Not enough articles to cluster.")
                return 0

            ids = [r[0] for r in rows]
            dates = [r[4] for r in rows]
            texts = [build_text(r[1], r[2], r[3]) for r in rows]

            vec = TfidfVectorizer(
                stop_words=STOP_WORDS,
                token_pattern=r"(?u)\b[a-zA-Z]{2,}\b",
                sublinear_tf=True,
                ngram_range=(1, 2),
                min_df=2,
                max_df=0.5,
                max_features=8000,
            )
            X = vec.fit_transform(texts)
            terms = vec.get_feature_names_out()

            model = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=DISTANCE_THRESHOLD,
                metric="cosine",
                linkage="average",
            )
            labels = model.fit_predict(X.toarray())

            # rebuild: deleting clusters sets articles.cluster_id to null
            cur.execute("delete from clusters")

            created = 0
            sizes = []
            for lab in sorted(set(labels)):
                idx = [i for i, l in enumerate(labels) if l == lab]
                if len(idx) < MIN_CLUSTER_SIZE:
                    continue

                Xc = X[idx]
                centroid = np.asarray(Xc.mean(axis=0)).ravel()
                doc_counts = np.asarray((Xc > 0).sum(axis=0)).ravel()
                titles = [rows[i][1].lower() for i in idx]
                keywords = pick_keywords(centroid, doc_counts, len(idx), terms, titles)
                label = ", ".join(pretty(k) for k in keywords[:3]) or "Other stories"

                pubs = [dates[i] for i in idx if dates[i] is not None]
                first_pub = min(pubs) if pubs else None
                last_pub = max(pubs) if pubs else None

                cur.execute(
                    "insert into clusters "
                    "(label, keywords, article_count, first_published_at, last_published_at) "
                    "values (%s, %s, %s, %s, %s) returning id",
                    (label, keywords, len(idx), first_pub, last_pub),
                )
                cluster_id = cur.fetchone()[0]
                cur.execute(
                    "update articles set cluster_id = %s where id = any(%s)",
                    (cluster_id, [ids[i] for i in idx]),
                )
                created += 1
                sizes.append(len(idx))

        conn.commit()
        print(f"{len(rows)} articles -> {created} clusters (sizes: {sorted(sizes, reverse=True)})")
        return created
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    run_clustering()