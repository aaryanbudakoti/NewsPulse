import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()


def get_conn():
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(url, connect_timeout=10)