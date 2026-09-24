from db import get_conn

with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute(
            "select table_name from information_schema.tables "
            "where table_schema='public' and table_name in "
            "('clusters','articles','ingest_jobs') order by 1"
        )
        print(cur.fetchall())