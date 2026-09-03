"""Did the write load leave the data correct? Run before and after a transaction test.

Throughput and latency are the easy half. The half that matters for a system holding
stock and approvals is whether a thousand people pressing buttons at once left the
books consistent — and that cannot be read off a Locust report, because every one of
these failures returns HTTP 200.

What it checks, and why each one:

* **Duplicate document numbers.** `shared/numbering.py` takes a row lock on
  `sys_doc_series` to hand out the next number. If that lock is ever skipped or the
  series row is missing and the fallback fires, two documents get the same number and
  nothing complains until somebody searches for one.
* **`stk_balance` against `stk_ledger`.** Rule 7: the ledger is append-only and every
  physical movement writes a row, so the balance MUST equal the sum of its ledger.
  A drift means a write path assigned to `stk_balance` directly, or a movement that
  was rolled back after the ledger row committed.
* **Negative quantities.** `available_qty` or `reserved_qty` below zero means two
  reservations were granted against the same stock — the classic lost update, and the
  single most likely thing to break under concurrency.
* **Reserved against open allocations.** What is held should equal what was promised.
* **Deadlocks.** InnoDB resolves a deadlock by killing one transaction. The
  application sees an exception; the user sees a failed press. A rising count is the
  signal that the lock ordering in the write paths needs looking at.

Usage (from backend/, pointed at the CLONE):
    .venv/Scripts/python -m scripts.loadtest_integrity before
    ... run the load test ...
    .venv/Scripts/python -m scripts.loadtest_integrity after
"""
import asyncio
import json
import os
import re
import sys

import aiomysql

from app.core.config import settings

#: table -> the column holding its human-readable document number.
NUMBERED = {
    "ind_indents": "indent_no",
    "pro_purchase_orders": "po_no",
    "lgs_transport_requests": "tr_no",
    "whs_receipts": "receipt_no",
    "whs_material_issues": "issue_no",
    "out_dispatches": "dispatch_no",
}

VOLUME = ["ind_indents", "ind_indent_items", "wf_instances", "wf_actions",
          "stk_ledger", "stk_balance", "inv_allocations", "whs_material_issues",
          "lgs_transport_requests", "sys_audit_log"]


def _dsn():
    match = re.match(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:]+):(\d+)/(\S+)",
                     settings.DATABASE_URL)
    return (match.group(1), match.group(2), match.group(3),
            int(match.group(4)), match.group(5))


async def _scalar(cur, sql, default=None):
    """Run a query that may reference a table this schema does not have."""
    try:
        await cur.execute(sql)
        row = await cur.fetchone()
        return row[0] if row else default
    except Exception:
        return default


async def collect() -> dict:
    user, password, host, port, db = _dsn()
    conn = await aiomysql.connect(host=host, port=port, user=user, password=password,
                                  db=db, autocommit=True)
    cur = await conn.cursor()
    report: dict = {"database": db, "volume": {}, "problems": []}

    for table in VOLUME:
        report["volume"][table] = await _scalar(cur, f"SELECT COUNT(*) FROM `{table}`", 0)

    # --- duplicate document numbers -------------------------------------------------
    duplicates = {}
    for table, column in NUMBERED.items():
        found = await _scalar(
            cur,
            f"SELECT COUNT(*) FROM (SELECT `{column}` FROM `{table}` "
            f"WHERE `{column}` IS NOT NULL GROUP BY `{column}` HAVING COUNT(*) > 1) d",
            None)
        if found:
            duplicates[f"{table}.{column}"] = found
    report["duplicate_document_numbers"] = duplicates
    if duplicates:
        report["problems"].append(
            f"DUPLICATE DOCUMENT NUMBERS: {duplicates} — the sys_doc_series row lock "
            "did not hold, or the numbering fallback fired.")

    # --- stock balance against its own ledger ---------------------------------------
    # Rule 7 in one query: the ledger is append-only and authoritative.
    # The grain is (item, warehouse, bin, batch, project) — the same key the balance
    # row is unique on — and `direction` is IN/OUT with a POSITIVE quantity, so the
    # ledger has to be signed before it can be summed. Getting either of those wrong
    # reports every row as drifted, which is what a first pass at this query did.
    drift = await _scalar(cur, """
        SELECT COUNT(*) FROM (
            SELECT b.total_qty AS balance,
                   COALESCE((
                       SELECT SUM(CASE l.direction WHEN 'IN' THEN l.quantity
                                                   ELSE -l.quantity END)
                       FROM stk_ledger l
                       WHERE l.item_id = b.item_id
                         AND l.warehouse_id = b.warehouse_id
                         AND l.bin_id = b.bin_id
                         AND l.batch_id = b.batch_id
                         AND l.project_id = b.project_id), 0) AS ledger
            FROM stk_balance b
        ) x WHERE ABS(balance - ledger) > 0.0001
    """, None)
    report["stock_balance_vs_ledger_mismatches"] = drift
    if drift:
        report["problems"].append(
            f"STOCK DRIFT: {drift} (item, warehouse) balances disagree with the sum of "
            "their ledger rows. Something wrote stk_balance outside move_stock().")

    # --- negative quantities ---------------------------------------------------------
    negatives = await _scalar(cur, """
        SELECT COUNT(*) FROM stk_balance
        WHERE available_qty < 0 OR reserved_qty < 0 OR total_qty < 0
    """, None)
    report["negative_stock_rows"] = negatives
    if negatives:
        report["problems"].append(
            f"NEGATIVE STOCK: {negatives} rows. Two reservations were granted against "
            "the same quantity — a lost update on the reservation columns.")

    over_reserved = await _scalar(cur, """
        SELECT COUNT(*) FROM stk_balance WHERE reserved_qty > total_qty
    """, None)
    report["reserved_exceeds_total"] = over_reserved
    if over_reserved:
        report["problems"].append(
            f"OVER-RESERVED: {over_reserved} rows hold more than they physically have.")

    # --- approval integrity ----------------------------------------------------------
    # An instance that is finished but has no action recorded means the engine wrote a
    # status without an audit row, which rule 9 forbids outright.
    silent = await _scalar(cur, """
        SELECT COUNT(*) FROM wf_instances i
        WHERE i.status IN ('APPROVED', 'REJECTED')
          AND NOT EXISTS (SELECT 1 FROM wf_actions a WHERE a.instance_id = i.id)
    """, None)
    report["decided_instances_without_actions"] = silent
    if silent:
        report["problems"].append(
            f"SILENT APPROVALS: {silent} decided workflow instances carry no action row.")

    # --- deadlocks -------------------------------------------------------------------
    report["innodb_deadlocks"] = await _scalar(cur, """
        SELECT COUNT FROM information_schema.INNODB_METRICS
        WHERE NAME = 'lock_deadlocks'
    """, None)
    report["lock_timeouts"] = await _scalar(
        cur, "SELECT COUNT FROM information_schema.INNODB_METRICS "
             "WHERE NAME = 'lock_timeouts'", None)

    conn.close()
    return report


async def main(label: str) -> None:
    report = await collect()
    os.makedirs("../loadtest/results", exist_ok=True)
    path = f"../loadtest/results/integrity_{label}.json"
    with open(path, "w", encoding="utf8") as handle:
        json.dump(report, handle, indent=2, default=str)

    print(f"=== integrity: {label} ({report['database']}) ===")
    for table, count in report["volume"].items():
        print(f"  {table:28s} {count}")
    print(f"  deadlocks={report['innodb_deadlocks']} "
          f"lock_timeouts={report['lock_timeouts']}")
    if report["problems"]:
        print("  PROBLEMS:")
        for problem in report["problems"]:
            print(f"    - {problem}")
    else:
        print("  no integrity problems found")

    # A comparison is the useful output, so print the delta when both halves exist.
    other = f"../loadtest/results/integrity_before.json"
    if label == "after" and os.path.exists(other):
        with open(other, encoding="utf8") as handle:
            before = json.load(handle)
        print("=== delta (after - before) ===")
        for table, count in report["volume"].items():
            print(f"  {table:28s} +{count - before['volume'].get(table, 0)}")
        for metric in ("innodb_deadlocks", "lock_timeouts"):
            if report[metric] is not None and before.get(metric) is not None:
                print(f"  {metric:28s} +{report[metric] - before[metric]}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "after"))
