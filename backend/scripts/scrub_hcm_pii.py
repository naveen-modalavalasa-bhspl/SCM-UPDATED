"""Remove sensitive fields from hcm_*.raw payloads already stored.

    .venv/Scripts/python -m scripts.scrub_hcm_pii --check   # report only
    .venv/Scripts/python -m scripts.scrub_hcm_pii           # rewrite the rows

Rule 10 forbids storing bank, salary, EPFO and health data from HCM. The sync used to
persist the whole payload verbatim, so PAN, Aadhaar, date of birth and gender also
landed in `raw`. sync.py now scrubs on write; this cleans what is already there.

Safe to re-run: a scrubbed row simply reports no change.
"""
import json
import re
import sys
from urllib.parse import unquote

import pymysql

from app.core.config import settings
from app.platform.hcm.mappers import SENSITIVE_FIELDS, scrub_raw

DSN = re.compile(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(.+)")
TABLES = ["hcm_employees", "hcm_positions", "hcm_position_assignments",
          "hcm_offices", "hcm_departments", "hcm_sections", "hcm_facilities",
          "hcm_facility_types", "hcm_position_levels"]


def connect():
    match = DSN.match(settings.DATABASE_URL)
    if not match:
        raise SystemExit("DATABASE_URL must be mysql+aiomysql://user:pw@host:port/db")
    user, password, host, port, database = match.groups()
    # Percent-encoded in the URL; pymysql needs it raw.
    return pymysql.connect(host=host, port=int(port), user=unquote(user),
                           password=unquote(password), database=database,
                           connect_timeout=20, autocommit=False), database


def main() -> None:
    check_only = "--check" in sys.argv
    conn, db = connect()
    print(f"Connected to {db}")
    print(f"Scrubbing {len(SENSITIVE_FIELDS)} field names, recursively.\n")

    total_changed = 0
    try:
        with conn.cursor() as cur:
            for table in TABLES:
                cur.execute("SELECT 1 FROM information_schema.COLUMNS "
                            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
                            "AND COLUMN_NAME='raw'", (db, table))
                if cur.fetchone() is None:
                    continue

                cur.execute(f"SELECT id, raw FROM {table} WHERE raw IS NOT NULL")
                rows = cur.fetchall()
                dirty = []
                for row_id, raw in rows:
                    if raw is None:
                        continue
                    payload = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
                    cleaned = scrub_raw(payload)
                    if cleaned != payload:
                        dirty.append((json.dumps(cleaned), row_id))

                verb = "would scrub" if check_only else "scrubbed"
                print(f"  {table:28} {len(dirty):>5} / {len(rows)} {verb}")
                total_changed += len(dirty)

                if dirty and not check_only:
                    cur.executemany(f"UPDATE {table} SET raw=%s WHERE id=%s", dirty)

        if check_only:
            conn.rollback()
        else:
            conn.commit()
    finally:
        conn.close()

    if check_only:
        print(f"\n{total_changed} row(s) still hold sensitive fields. "
              f"Re-run without --check to remove them.")
        sys.exit(1 if total_changed else 0)
    print(f"\nScrubbed {total_changed} row(s).")


if __name__ == "__main__":
    main()
