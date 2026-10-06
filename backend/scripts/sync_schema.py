"""Bring a database's schema up to the models in one pass: every missing table, every
missing column.

For a database whose `alembic_version` says head while migrations never actually ran on
it (stamped by hand, or bootstrapped from older models) -- `alembic upgrade head` does
nothing there, and each screen 500s on its own `Unknown column` one at a time.

Additive only: creates tables and adds columns, never drops, alters or re-types
anything. A bare run only lists what is missing; `--apply` adds it. Idempotent.

    python -m scripts.sync_schema            # report
    python -m scripts.sync_schema --apply    # fix
"""
import asyncio
import sys

from sqlalchemy import inspect
from sqlalchemy.schema import CreateColumn

from app.core.database import Base, engine
import app.main  # noqa: F401  -- imports every model so the metadata is complete


def _missing(sync_conn):
    insp = inspect(sync_conn)
    existing = set(insp.get_table_names())
    tables, columns = [], []
    for table in Base.metadata.sorted_tables:
        if table.name not in existing:
            tables.append(table)
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        columns += [(table, col) for col in table.columns if col.name not in have]
    return tables, columns


def _apply(sync_conn, tables, columns):
    for table in tables:
        table.create(sync_conn, checkfirst=True)
    for table, col in columns:
        ddl = str(CreateColumn(col).compile(dialect=sync_conn.dialect))
        # NOT NULL without a default cannot be added to a table that already has rows.
        if not col.nullable and col.server_default is None:
            ddl = ddl.replace(" NOT NULL", " NULL")
        sync_conn.exec_driver_sql(f"ALTER TABLE `{table.name}` ADD COLUMN {ddl}")


def _missing_indexes(sync_conn):
    """Model indexes the database lacks. Tables created by hand never got theirs."""
    insp = inspect(sync_conn)
    existing = set(insp.get_table_names())
    out = []
    for table in Base.metadata.sorted_tables:
        if table.name not in existing:
            continue
        have = {ix["name"] for ix in insp.get_indexes(table.name)}
        have |= {uc["name"] for uc in insp.get_unique_constraints(table.name)}
        out += [ix for ix in table.indexes if ix.name and ix.name not in have]
    return out


def _apply_indexes(sync_conn, indexes) -> list[str]:
    """Create each one on its own: a UNIQUE index over duplicate rows must not stop
    the rest. Returns the ones that could not be built, with the reason."""
    failed = []
    for ix in indexes:
        try:
            ix.create(sync_conn, checkfirst=False)
        except Exception as exc:              # noqa: BLE001 -- reported, never fatal
            failed.append(f"{ix.table.name}.{ix.name}: {str(exc).splitlines()[0][:160]}")
    return failed


async def main(apply: bool) -> None:
    async with engine.begin() as conn:
        tables, columns = await conn.run_sync(_missing)
        for t in tables:
            print(f"missing table   {t.name}")
        for t, c in columns:
            print(f"missing column  {t.name}.{c.name}  {c.type}")
        if not tables and not columns:
            print("schema matches the models -- nothing to do")
            return
        if apply:
            await conn.run_sync(_apply, tables, columns)
            print(f"added {len(tables)} table(s), {len(columns)} column(s)")
        else:
            print("dry run -- re-run with --apply to add them")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
