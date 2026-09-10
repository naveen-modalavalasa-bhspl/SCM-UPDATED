#!/usr/bin/env python3
"""Create the local `admin` login WITHOUT the virtualenv. Idempotent.

The normal way to do this is `python -m scripts.create_admin_login` from `backend/`,
which imports the app and hashes the password itself. On a deployed box with no
`.venv` there is no app to import and no bcrypt to hash with, so this script:

  * reads `DATABASE_URL` out of `backend/.env` (or takes `--url`),
  * writes the SQL to a temporary FILE and feeds it to MySQL — never inline in a
    shell, because a bcrypt hash is full of `$` and a shell eats `$2b`, `$12` and
    `$Pdtr` as variable names, storing a stump that can never match a password,
  * carries a pre-computed hash of the standard password rather than hashing one.

Talks to MySQL through `pymysql` if it happens to be importable, and otherwise
through the `mysql` command-line client. One of the two is always present on a box
that is running this system.

Run it from anywhere:

    python3 backend/scripts/create_admin_login_standalone.py
    python3 create_admin_login_standalone.py --url mysql://user:pw@127.0.0.1:3306/scm_erp

Login afterwards: admin / Bavya@123 — change it from the UI once you are in.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

ADMIN_ID = 900001
ADMIN_CODE = "admin"
ADMIN_PASSWORD = "Bavya@123"

# bcrypt hash of ADMIN_PASSWORD, generated with the same library the app verifies
# with. It is a constant on purpose: hashing here would need bcrypt installed, which
# is the very thing this script exists to do without.
ADMIN_HASH = "$2b$12$PdtrHqu3JPryWbJibLoeK.xnNGAuuSE6b4d5ixij9B70.bA5cEeyG"

STATEMENTS = [
    # 1. The employee row. Identity in this system is `hcm_employees` and there is no
    #    users table. Id 900001 sits above the HCM feed's id space on purpose, so a
    #    sync or a mirror prune never touches it.
    """
    INSERT INTO hcm_employees
        (id, emp_code, full_name, email, is_active, raw, synced_at)
    VALUES
        ({admin_id}, '{admin_code}', 'Administrator', NULL, 1, '{{}}', UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE
        emp_code = VALUES(emp_code), full_name = VALUES(full_name), is_active = 1
    """,
    # 2. Grant the ADMIN role.
    """
    INSERT INTO rbac_user_roles (employee_id, role_id, assigned_at)
    SELECT {admin_id}, r.id, UTC_TIMESTAMP() FROM rbac_roles r WHERE r.code = 'ADMIN'
    ON DUPLICATE KEY UPDATE assigned_at = UTC_TIMESTAMP()
    """,
    # 3. Top the ADMIN role up to EVERY permission that exists, not the subset it was
    #    seeded with. Miss this and the account signs in to a half-empty menu.
    """
    INSERT INTO rbac_role_permissions (role_id, permission_id)
    SELECT x.role_id, x.permission_id FROM (
        SELECT r.id AS role_id, p.id AS permission_id
        FROM rbac_roles r
        CROSS JOIN rbac_permissions p
        LEFT JOIN rbac_role_permissions rp
               ON rp.role_id = r.id AND rp.permission_id = p.id
        WHERE r.code = 'ADMIN' AND rp.role_id IS NULL
    ) AS x
    """,
    # 4. The password.
    """
    INSERT INTO sys_local_credentials
        (employee_id, password_hash, must_change, failed_attempts,
         locked_until, last_login_at, created_at, updated_at)
    VALUES
        ({admin_id}, '{admin_hash}', 0, 0, NULL, NULL,
         UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash), must_change = 0,
        failed_attempts = 0, locked_until = NULL, updated_at = UTC_TIMESTAMP()
    """,
]

CHECKS = [
    ("database", "SELECT DATABASE()"),
    ("employee", "SELECT CONCAT(id,' / ',emp_code,' / active=',is_active) "
                 "FROM hcm_employees WHERE id={admin_id}"),
    ("admin role", "SELECT CONCAT('role_id=',role_id) FROM rbac_user_roles "
                   "WHERE employee_id={admin_id}"),
    ("permissions", "SELECT CONCAT(COUNT(*),' of ',(SELECT COUNT(*) FROM rbac_permissions)) "
                    "FROM rbac_role_permissions "
                    "WHERE role_id=(SELECT id FROM rbac_roles WHERE code='ADMIN')"),
    ("password", "SELECT CONCAT('length=',LENGTH(password_hash),' starts=',"
                 "LEFT(password_hash,7)) FROM sys_local_credentials "
                 "WHERE employee_id={admin_id}"),
    ("lockout", "SELECT CONCAT('failed=',failed_attempts,' locked_until=',"
                "IFNULL(locked_until,'none')) FROM sys_local_credentials "
                "WHERE employee_id={admin_id}"),
]


def fill(sql):
    return sql.format(admin_id=ADMIN_ID, admin_code=ADMIN_CODE, admin_hash=ADMIN_HASH)


def find_env():
    """`backend/.env`, whether this is run from the repo root, from `backend/`, or
    from `backend/scripts/`."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        os.path.join(here, os.pardir, ".env"),          # backend/.env
        os.path.join(here, os.pardir, os.pardir, "backend", ".env"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(os.getcwd(), "backend", ".env"),
    ):
        path = os.path.normpath(candidate)
        if os.path.isfile(path):
            return path
    return None


def url_from_env(path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "DATABASE_URL":
                return value.strip().strip('"').strip("'")
    return None


def parse_url(url):
    """`mysql+aiomysql://user:pass@host:port/db` -> the parts MySQL needs."""
    cleaned = re.sub(r"^mysql\+\w+://", "mysql://", url)
    parts = urlparse(cleaned)
    if not parts.hostname or not parts.path.strip("/"):
        raise SystemExit(f"DATABASE_URL is not a MySQL URL: {url}")
    return {
        "host": parts.hostname,
        "port": parts.port or 3306,
        "user": unquote(parts.username or ""),
        "password": unquote(parts.password or ""),
        "db": parts.path.strip("/").split("?")[0],
    }


def run_with_pymysql(cfg):
    import pymysql

    conn = pymysql.connect(host=cfg["host"], port=cfg["port"], user=cfg["user"],
                           password=cfg["password"], database=cfg["db"],
                           autocommit=False)
    try:
        with conn.cursor() as cur:
            for i, statement in enumerate(STATEMENTS, 1):
                cur.execute(fill(statement))
                print(f"  step {i}: ok ({cur.rowcount} row(s) affected)")
            conn.commit()
            print()
            for label, query in CHECKS:
                cur.execute(fill(query))
                row = cur.fetchone()
                print(f"  {label:12} {row[0] if row else 'MISSING'}")
    finally:
        conn.close()


def run_with_client(cfg):
    """Feed the SQL to the `mysql` client through FILES, never through the shell."""
    keep_sql = False
    creds = tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False,
                                        encoding="utf-8")
    script = tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False,
                                         encoding="utf-8")
    try:
        # The password goes in a defaults file, not on the command line, where it
        # would show up in `ps` for every user on the box.
        creds.write("[client]\n"
                    f"host={cfg['host']}\n"
                    f"port={cfg['port']}\n"
                    f"user={cfg['user']}\n"
                    f"password=\"{cfg['password']}\"\n")
        creds.close()
        os.chmod(creds.name, 0o600)

        body = ";\n".join(fill(s).strip() for s in STATEMENTS) + ";\n"
        body += "SELECT '---' AS '';\n"
        for label, query in CHECKS:
            body += f"SELECT '{label}' AS check_name, ({fill(query)}) AS value;\n"
        script.write(body)
        script.close()

        with open(script.name, encoding="utf-8") as handle:
            try:
                result = subprocess.run(
                    ["mysql", f"--defaults-extra-file={creds.name}", "--batch",
                     "--table", cfg["db"]],
                    stdin=handle, capture_output=True, text=True)
            except FileNotFoundError:
                keep_sql = True
                raise SystemExit(
                    "Neither pymysql nor the `mysql` client is available.\n"
                    "Install one of them (`pip install pymysql`, or "
                    "`sudo apt install mysql-client`), or run this file by hand "
                    "against the database:\n"
                    f"  {script.name}\n"
                    "It has been left on disk for that purpose. Feed it in with "
                    "`mysql <db> < <file>`, never pasted into a shell, or the "
                    "`$` in the password hash will be eaten.") from None
        if result.stdout.strip():
            print(result.stdout.rstrip())
        if result.returncode != 0:
            print(result.stderr.rstrip(), file=sys.stderr)
            raise SystemExit(f"mysql exited {result.returncode}")
    finally:
        leave = {script.name} if keep_sql else set()
        for path in (creds.name, script.name):
            if path in leave:
                continue
            try:
                os.unlink(path)
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser(description="Create the local admin login.")
    ap.add_argument("--url", help="DATABASE_URL; read from backend/.env when omitted")
    ap.add_argument("--client", action="store_true",
                    help="force the mysql client even if pymysql is importable")
    args = ap.parse_args()

    url = args.url
    if not url:
        env = find_env()
        if not env:
            raise SystemExit(
                "No backend/.env found and no --url given. Pass the connection "
                "string, e.g. --url mysql://user:pw@127.0.0.1:3306/scm_erp")
        url = url_from_env(env)
        if not url:
            raise SystemExit(f"No DATABASE_URL line in {env}")
        print(f"Using DATABASE_URL from {env}")

    cfg = parse_url(url)
    print(f"Target: {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['db']}\n")

    use_client = args.client
    if not use_client:
        try:
            import pymysql  # noqa: F401
        except ImportError:
            use_client = True

    if use_client:
        print("Driver: mysql command-line client\n")
        run_with_client(cfg)
    else:
        print("Driver: pymysql\n")
        run_with_pymysql(cfg)

    print(f"\nDone. Sign in as '{ADMIN_CODE}' with '{ADMIN_PASSWORD}' and change it.")
    print("If the app was already running, restart it so the permission cache "
          "picks up the new grants.")


if __name__ == "__main__":
    main()
