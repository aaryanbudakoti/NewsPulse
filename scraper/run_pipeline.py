import sys
import traceback

from cluster import run_clustering
from db import get_conn
from ingest import run_ingest


def update_job(job_id, status, added=0, error=None):
    if not job_id:
        return
    conn = get_conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "update ingest_jobs set status = %s, articles_added = %s, error = %s, "
                "finished_at = case when %s in ('completed', 'failed') then now() else finished_at end "
                "where id = %s::uuid",
                (status, added, error, status, job_id),
            )
    finally:
        conn.close()


def main():
    job_id = sys.argv[1] if len(sys.argv) > 1 else None
    update_job(job_id, "running")
    try:
        added = run_ingest()
        run_clustering()
        update_job(job_id, "completed", added=added)
        print("PIPELINE_OK")
        return 0
    except Exception as e:
        traceback.print_exc()
        update_job(job_id, "failed", error=str(e)[:500])
        return 1


if __name__ == "__main__":
    sys.exit(main())