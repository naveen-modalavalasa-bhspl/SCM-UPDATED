"""Apply the Admin & Masters DDL to the database named by DATABASE_URL, then verify it.

    .venv/Scripts/python -m scripts.apply_admin_masters          # apply, then verify
    .venv/Scripts/python -m scripts.apply_admin_masters --check  # verify only

Why this exists rather than `alembic upgrade head`: the live SCM_REBUILD schema is
maintained by the DB team and was not built from these migrations, so Alembic has no
usable revision history against it. Existence is checked in Python instead of with
stored procedures, so the whole thing is re-runnable and each step reports itself.

conftest builds the test schema from Base.metadata, so pytest cannot catch a mismatch
between the models and this database. That is exactly what the verify pass below does.
"""
import re
import sys
from urllib.parse import unquote

import pymysql

from app.core.config import settings

DSN = re.compile(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(.+)")

NEW_TABLES: dict[str, str] = {
    "rbac_user_groups": """
        CREATE TABLE rbac_user_groups (
            id          BIGINT       NOT NULL AUTO_INCREMENT,
            code        VARCHAR(50)  NOT NULL,
            name        VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL,
            parent_id   BIGINT       NULL,
            group_type  VARCHAR(20)  NOT NULL COMMENT 'ROLE|POSITION|LOCATION',
            role_id     BIGINT       NULL,
            position_id BIGINT       NULL,
            location_id BIGINT       NULL COMMENT 'whs_warehouses.id for sub-groups',
            is_active   TINYINT(1)   NOT NULL DEFAULT 1,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_rbac_user_groups_code (code),
            KEY ix_rbac_user_groups_parent_id (parent_id),
            KEY ix_rbac_user_groups_role_id (role_id),
            KEY ix_rbac_user_groups_position_id (position_id),
            KEY ix_rbac_user_groups_location_id (location_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rbac_user_group_members": """
        CREATE TABLE rbac_user_group_members (
            group_id    BIGINT   NOT NULL,
            employee_id BIGINT   NOT NULL,
            added_by_id BIGINT   NULL,
            added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_id, employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rule_events": """
        CREATE TABLE rule_events (
            code           VARCHAR(50)  NOT NULL,
            name           VARCHAR(200) NOT NULL,
            module         VARCHAR(50)  NULL,
            description    VARCHAR(300) NULL,
            context_schema JSON         NULL,
            is_active      TINYINT(1)   NOT NULL DEFAULT 1,
            PRIMARY KEY (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rule_rules": """
        CREATE TABLE rule_rules (
            id             BIGINT       NOT NULL AUTO_INCREMENT,
            event_code     VARCHAR(50)  NOT NULL,
            name           VARCHAR(200) NOT NULL,
            description    VARCHAR(300) NULL,
            priority       INT          NOT NULL DEFAULT 100,
            stop_on_match  TINYINT(1)   NOT NULL DEFAULT 0,
            is_active      TINYINT(1)   NOT NULL DEFAULT 1,
            effective_from DATE         NULL,
            effective_to   DATE         NULL,
            created_by_id  BIGINT       NULL,
            created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY ix_rule_rules_event_active (event_code, is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rule_conditions": """
        CREATE TABLE rule_conditions (
            id          BIGINT       NOT NULL AUTO_INCREMENT,
            rule_id     BIGINT       NOT NULL,
            field_name  VARCHAR(50)  NOT NULL,
            operator    VARCHAR(10)  NOT NULL,
            field_value VARCHAR(200) NOT NULL,
            logic       VARCHAR(5)   NOT NULL DEFAULT 'AND',
            PRIMARY KEY (id),
            KEY ix_rule_conditions_rule_id (rule_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rule_actions": """
        CREATE TABLE rule_actions (
            id          BIGINT      NOT NULL AUTO_INCREMENT,
            rule_id     BIGINT      NOT NULL,
            seq         INT         NOT NULL DEFAULT 1,
            action_type VARCHAR(30) NOT NULL,
            params      JSON        NULL,
            PRIMARY KEY (id),
            KEY ix_rule_actions_rule_id (rule_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "rule_executions": """
        CREATE TABLE rule_executions (
            id         BIGINT      NOT NULL AUTO_INCREMENT,
            event_code VARCHAR(50) NOT NULL,
            rule_id    BIGINT      NULL,
            doc_type   VARCHAR(30) NULL,
            doc_id     BIGINT      NULL,
            matched    TINYINT(1)  NOT NULL DEFAULT 0,
            context    JSON        NULL,
            actions    JSON        NULL,
            error      TEXT        NULL,
            acted_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY ix_rule_executions_event_code (event_code),
            KEY ix_rule_executions_rule_id (rule_id),
            KEY ix_rule_executions_doc_id (doc_id),
            KEY ix_rule_executions_acted_at (acted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "sys_notification_rules": """
        CREATE TABLE sys_notification_rules (
            id             BIGINT       NOT NULL AUTO_INCREMENT,
            event_code     VARCHAR(50)  NOT NULL,
            stage          VARCHAR(100) NULL,
            recipient_type VARCHAR(20)  NOT NULL,
            recipient_id   BIGINT       NULL,
            recipient_name VARCHAR(200) NULL,
            channel        VARCHAR(20)  NOT NULL DEFAULT 'IN_APP',
            template       TEXT         NULL,
            is_active      TINYINT(1)   NOT NULL DEFAULT 1,
            created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY ix_sys_notification_rules_event_code (event_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
}

# (table, column, DDL fragment)
NEW_COLUMNS = [
    ("sys_doc_series", "reset_policy",
     "reset_policy VARCHAR(10) NULL COMMENT 'NEVER|YEARLY|MONTHLY'"),
    ("sys_doc_series", "last_reset_period", "last_reset_period VARCHAR(10) NULL"),
    # 0 not NULL: MySQL lets NULLs repeat inside a unique index, which would allow
    # duplicate balance rows. Matches the DB team's bin_id / batch_id convention.
    ("stk_balance", "project_id",
     "project_id BIGINT NOT NULL DEFAULT 0 COMMENT '0 = no project'"),
    ("stk_balance", "project_name", "project_name VARCHAR(200) NULL"),
    ("stk_ledger", "project_id",
     "project_id BIGINT NOT NULL DEFAULT 0 COMMENT '0 = no project'"),
    # HCM's org role and project, mirrored onto the position. role_name here is
    # "Network Technicians" — what someone IS — and is unrelated to rbac_roles,
    # which is what they MAY DO.
    ("hcm_positions", "role_id", "role_id BIGINT NULL"),
    ("hcm_positions", "role_name", "role_name VARCHAR(200) NULL"),
    ("hcm_positions", "job_name", "job_name VARCHAR(200) NULL"),
    ("hcm_positions", "project_id", "project_id BIGINT NULL"),
    ("hcm_positions", "project_name", "project_name VARCHAR(200) NULL"),
    ("hcm_employees", "project_id", "project_id BIGINT NULL"),
    ("hcm_employees", "project_name", "project_name VARCHAR(200) NULL"),
]

# (table, index, columns, unique)
NEW_INDEXES = [
    ("stk_balance", "ix_stk_balance_project_id", "project_id", False),
    ("stk_ledger", "ix_stk_ledger_project_id", "project_id", False),
    ("stk_balance", "uq_stk_balance_item_wh_bin_batch_proj",
     "item_id, warehouse_id, bin_id, batch_id, project_id", True),
    # HCM_ROLE groups resolve by joining assignments to positions on role_id.
    ("hcm_positions", "ix_hcm_positions_role_id", "role_id", False),
    ("hcm_positions", "ix_hcm_positions_project_id", "project_id", False),
    ("hcm_employees", "ix_hcm_employees_project_id", "project_id", False),
]

EVENTS = [
    ("INDENT_SUBMITTED", "Indent submitted", "indents",
     "A requester submitted an indent for approval and fulfillment routing",
     '{"indent_id":"number","indent_no":"string","category_code":"string",'
     '"item_id":"number","quantity":"number","estimated_value":"number",'
     '"requester_id":"number","requester_position_id":"number",'
     '"department_id":"number","warehouse_id":"number","project_id":"number",'
     '"priority":"string"}'),
    ("INDENT_APPROVED", "Indent approved", "indents",
     "Every approval stage on an indent completed",
     '{"indent_id":"number","indent_no":"string","quantity":"number",'
     '"estimated_value":"number","warehouse_id":"number","project_id":"number"}'),
    ("PO_SUBMITTED", "Purchase order submitted", "procurement",
     "A purchase order was submitted for approval",
     '{"po_id":"number","po_no":"string","vendor_id":"number",'
     '"total_amount":"number","buyer_id":"number","department_id":"number"}'),
    ("GRN_RECEIVED", "Goods received", "logistics",
     "A receipt was booked against a purchase order",
     '{"grn_id":"number","po_id":"number","warehouse_id":"number",'
     '"item_id":"number","accepted_quantity":"number"}'),
    ("STOCK_BELOW_THRESHOLD", "Stock below threshold", "logistics",
     "An item balance fell under its reorder level",
     '{"item_id":"number","item_code":"string","warehouse_id":"number",'
     '"project_id":"number","available_qty":"number","reorder_level":"number"}'),
]


def connect():
    match = DSN.match(settings.DATABASE_URL)
    if not match:
        raise SystemExit("DATABASE_URL must be mysql+aiomysql://user:pw@host:port/db")
    user, password, host, port, database = match.groups()
    # The password is percent-encoded in the URL (# -> %23); pymysql needs it raw.
    return pymysql.connect(host=host, port=int(port), user=unquote(user),
                           password=unquote(password), database=database,
                           connect_timeout=20, autocommit=True), database


def has_table(cur, db, table) -> bool:
    cur.execute("SELECT 1 FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s", (db, table))
    return cur.fetchone() is not None


def has_column(cur, db, table, column) -> bool:
    cur.execute("SELECT 1 FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND COLUMN_NAME=%s",
                (db, table, column))
    return cur.fetchone() is not None


def has_index(cur, db, table, index) -> bool:
    cur.execute("SELECT 1 FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND INDEX_NAME=%s",
                (db, table, index))
    return cur.fetchone() is not None


def apply(cur, db) -> None:
    for table, ddl in NEW_TABLES.items():
        if has_table(cur, db, table):
            print(f"  = table {table} already present")
            continue
        cur.execute(ddl)
        print(f"  + created {table}")

    for table, column, ddl in NEW_COLUMNS:
        if not has_table(cur, db, table):
            print(f"  ! {table} does not exist, skipping column {column}")
            continue
        if has_column(cur, db, table, column):
            print(f"  = {table}.{column} already present")
            continue
        cur.execute(f"ALTER TABLE `{table}` ADD COLUMN {ddl}")
        print(f"  + added {table}.{column}")

    cur.execute("UPDATE sys_doc_series SET reset_policy='NEVER' "
                "WHERE reset_policy IS NULL")
    if cur.rowcount:
        print(f"  ~ defaulted reset_policy on {cur.rowcount} series")

    for table, index, columns, unique in NEW_INDEXES:
        if not has_table(cur, db, table) or has_index(cur, db, table, index):
            print(f"  = index {table}.{index} already present")
            continue
        kind = "UNIQUE INDEX" if unique else "INDEX"
        cur.execute(f"ALTER TABLE `{table}` ADD {kind} `{index}` ({columns})")
        print(f"  + indexed {table}.{index}")

    cur.executemany(
        "INSERT INTO rule_events (code,name,module,description,context_schema,is_active)"
        " VALUES (%s,%s,%s,%s,%s,1) AS new"
        " ON DUPLICATE KEY UPDATE name=new.name, module=new.module,"
        " description=new.description, context_schema=new.context_schema", EVENTS)
    print(f"  + seeded {len(EVENTS)} rule_events")


def verify(cur, db) -> int:
    """Prove the models can actually query this database. Returns a failure count."""
    import app.all_models  # noqa: F401  (registers every table on Base.metadata)
    from app.core.database import Base

    failures = 0
    for table in sorted(Base.metadata.tables):
        if not has_table(cur, db, table):
            print(f"  MISSING TABLE  {table}")
            failures += 1
            continue
        cur.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s", (db, table))
        live = {r[0] for r in cur.fetchall()}
        mapped = {c.name for c in Base.metadata.tables[table].columns}
        missing = mapped - live
        if missing:
            # This is the 1054 "Unknown column" trap: a mapped column the table
            # lacks makes every SELECT on the model fail at runtime.
            print(f"  MAPPED-NOT-IN-DB  {table}: {', '.join(sorted(missing))}")
            failures += 1
    return failures


def main() -> None:
    check_only = "--check" in sys.argv
    conn, db = connect()
    print(f"Connected to {db}")
    try:
        with conn.cursor() as cur:
            if not check_only:
                print("\nApplying:")
                apply(cur, db)
            print("\nVerifying every mapped model against the live schema:")
            failures = verify(cur, db)
    finally:
        conn.close()

    if failures:
        print(f"\n{failures} model(s) do not match the database. "
              f"Those endpoints will fail with 1054 at runtime.")
        sys.exit(1)
    print("\nEvery mapped model matches the live schema.")


if __name__ == "__main__":
    main()
