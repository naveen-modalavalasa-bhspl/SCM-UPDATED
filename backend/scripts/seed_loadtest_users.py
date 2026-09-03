"""Give the load test a pool of real logins, in the CLONE only.

A load test that signs one user in a thousand times measures the wrong thing: it
warms one permission-cache key and one position lookup, so the RBAC cost that B-04
was about — an employee SELECT, a joined position lookup, a roles query and a
permissions join, per request — never appears. Real users have different positions,
different roles and different scopes, and the cache has to hold them all.

So this picks employees who ALREADY hold a role in the mirror (a login with no role
has no permissions and would 403 on every screen, which is not a load test either),
and sets one known password on them. One bcrypt, reused: hashing 300 rows
individually would take a minute and a half and prove nothing.

REFUSES to run against a database whose name does not look like a load-test clone.
The whole point of the clone is that nothing here reaches the working data.
"""
import asyncio
import re
import sys

import aiomysql

from app.core.config import settings
from app.core.security import hash_password

PASSWORD = "LoadTest#2026"
# Everybody with a credential and a position, not a slice of them. The approval
# ladder climbs the RAISER'S OWN reporting line, so the approver for an indent is
# whoever sits above the person who raised it. With a truncated pool most submitted
# indents park on somebody who has no load-test password, the approval stage starves,
# and every stage after it starves with it.
WANTED = 5000


def _dsn():
    match = re.match(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:]+):(\d+)/(\S+)",
                     settings.DATABASE_URL)
    return (match.group(1), match.group(2), match.group(3),
            int(match.group(4)), match.group(5))


async def main(out_path: str) -> None:
    user, password, host, port, db = _dsn()
    if "loadtest" not in db.lower():
        raise SystemExit(
            f"Refusing to rewrite credentials in {db!r} — point DATABASE_URL at the "
            "clone (see scripts/clone_for_loadtest.py) before running this.")

    conn = await aiomysql.connect(host=host, port=port, user=user, password=password,
                                  db=db, autocommit=True)
    cur = await conn.cursor()

    # A thousand people doing operations means a thousand people HOLDING A ROLE, and
    # in this mirror only ten do — everybody else has a credential and no grants, so
    # they would 403 on every business endpoint and the test would measure the guard
    # rejecting them. So the clone is given the population a real deployment has:
    # active employees who already have a credential and a position assignment, dealt
    # a spread of the roles that actually exist.
    #
    # The SPREAD matters as much as the count. One role for everybody would collapse
    # `get_user_permissions` onto a handful of cache keys and hide exactly the cost
    # B-04 is about — the per-(employee, position) lookup that used to run 4-6 queries
    # on every single authenticated request.
    await cur.execute(
        """
        SELECT id FROM rbac_roles
        WHERE is_active = 1 AND code IN (
            'jp_22_oe', 'jp_22_sph', 'jp_22_regional_manager', 'jp_22_district_manager',
            'jp_23_logistics', 'jp_23_inventory_manager', 'jp_0_wm', 'floor_in_charge')
        ORDER BY id
        """)
    role_ids = [row[0] for row in await cur.fetchall()]
    if not role_ids:
        raise SystemExit("None of the expected job-profile roles exist in this clone.")

    await cur.execute(
        """
        SELECT DISTINCT e.id, e.emp_code
        FROM hcm_employees e
        JOIN hcm_position_assignments pa ON pa.employee_id = e.id
        JOIN sys_local_credentials c ON c.employee_id = e.id
        WHERE e.is_active = 1
        ORDER BY e.id
        LIMIT %s
        """,
        (WANTED,))
    rows = await cur.fetchall()
    if not rows:
        raise SystemExit("No employee has both a credential and a position assignment.")

    await cur.executemany(
        "INSERT IGNORE INTO rbac_user_roles (employee_id, role_id, assigned_by_id, "
        "assigned_at) VALUES (%s, %s, NULL, NOW())",
        [(employee_id, role_ids[index % len(role_ids)])
         for index, (employee_id, _code) in enumerate(rows)])
    print(f"{len(rows)} employees dealt {len(role_ids)} roles round-robin")

    digest = hash_password(PASSWORD)
    ids = [row[0] for row in rows]
    await cur.execute(
        f"""UPDATE sys_local_credentials
            SET password_hash = %s, must_change = 0, failed_attempts = 0,
                locked_until = NULL
            WHERE employee_id IN ({','.join(['%s'] * len(ids))})""",
        [digest, *ids])

    with open(out_path, "w", encoding="utf8") as handle:
        for employee_id, emp_code in rows:
            handle.write(f"{employee_id}\n")
    print(f"{len(rows)} logins ready in {db}; ids written to {out_path}")
    print(f"password: {PASSWORD}")
    conn.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "loadtest_users.txt"))
