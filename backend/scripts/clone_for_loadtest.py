"""Clone the working database into a throwaway one, for load testing only.

A load test has to be free to mint credentials, seed a production-sized catalogue and
issue writes. None of that may happen against the database people are using, so it
happens against a copy — and the copy is made SERVER-SIDE (`CREATE TABLE ... LIKE`
plus `INSERT ... SELECT`) rather than through a dump, because 239 MB does not need to
travel out of MySQL and back to be duplicated inside it.

What the copy is NOT: `CREATE TABLE ... LIKE` carries the columns, indexes and
defaults but NOT the foreign keys. That is fine for measuring how the application
behaves under load — the FKs are the database refusing writes the application already
refuses — and it is not fine for anything else. Do not treat this clone as a restore.

Usage (from backend/):
    .venv/Scripts/python -m scripts.clone_for_loadtest SCM_LOADTEST
"""
import asyncio
import re
import sys

import aiomysql

from app.core.config import settings


def _dsn() -> tuple[str, str, str, int, str]:
    match = re.match(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:]+):(\d+)/(\S+)",
                     settings.DATABASE_URL)
    if not match:
        raise SystemExit(f"Cannot parse DATABASE_URL: {settings.DATABASE_URL}")
    return (match.group(1), match.group(2), match.group(3),
            int(match.group(4)), match.group(5))


async def clone(target: str) -> None:
    user, password, host, port, source = _dsn()
    if target.lower() == source.lower():
        raise SystemExit("Refusing to clone a database over itself")

    conn = await aiomysql.connect(host=host, port=port, user=user, password=password,
                                  autocommit=True)
    cur = await conn.cursor()

    await cur.execute(f"DROP DATABASE IF EXISTS `{target}`")
    await cur.execute(
        f"CREATE DATABASE `{target}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")

    await cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = %s AND table_type = 'BASE TABLE' ORDER BY table_name",
        (source,))
    tables = [row[0] for row in await cur.fetchall()]
    print(f"{source} -> {target}: {len(tables)} tables")

    # Off for the duration: with no FKs on the target there is nothing to check, and
    # leaving them on would only cost a lookup per row.
    await cur.execute("SET FOREIGN_KEY_CHECKS = 0")
    await cur.execute("SET UNIQUE_CHECKS = 0")

    copied = 0
    for name in tables:
        await cur.execute(f"CREATE TABLE `{target}`.`{name}` LIKE `{source}`.`{name}`")
        await cur.execute(
            f"INSERT INTO `{target}`.`{name}` SELECT * FROM `{source}`.`{name}`")
        copied += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        print(f"  {name}: {cur.rowcount} rows", flush=True)

    await cur.execute("SET FOREIGN_KEY_CHECKS = 1")
    await cur.execute("SET UNIQUE_CHECKS = 1")
    print(f"done: {copied} rows across {len(tables)} tables")
    conn.close()


if __name__ == "__main__":
    asyncio.run(clone(sys.argv[1] if len(sys.argv) > 1 else "SCM_LOADTEST"))
