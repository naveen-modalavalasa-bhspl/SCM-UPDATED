"""Apply the approved item-master expansion to the configured MySQL database.

This is an idempotent DB-team handoff script, not an Alembic migration:

    .venv/Scripts/python -m scripts.apply_item_master_expansion
    .venv/Scripts/python -m scripts.apply_item_master_expansion --check
"""
import re
import sys
from urllib.parse import unquote

import pymysql

from app.core.config import settings

DSN = re.compile(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(.+)")

TABLES = {
    "mst_general_names": """
        CREATE TABLE mst_general_names (
            id BIGINT NOT NULL AUTO_INCREMENT,
            code VARCHAR(10) NOT NULL,
            name VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            UNIQUE KEY uq_mst_general_names_code (code),
            KEY ix_mst_general_names_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "mst_manufacturers": """
        CREATE TABLE mst_manufacturers (
            id BIGINT NOT NULL AUTO_INCREMENT,
            code VARCHAR(10) NOT NULL,
            name VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            UNIQUE KEY uq_mst_manufacturers_code (code),
            KEY ix_mst_manufacturers_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "mst_dosage_forms": """
        CREATE TABLE mst_dosage_forms (
            id BIGINT NOT NULL AUTO_INCREMENT,
            code VARCHAR(10) NOT NULL,
            name VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            UNIQUE KEY uq_mst_dosage_forms_code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "mst_item_sub_classes": """
        CREATE TABLE mst_item_sub_classes (
            id BIGINT NOT NULL AUTO_INCREMENT,
            item_class_id BIGINT NOT NULL,
            item_class_code VARCHAR(10) NULL,
            item_class_name VARCHAR(200) NULL,
            code VARCHAR(10) NOT NULL,
            name VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            UNIQUE KEY uq_item_sub_class_code (item_class_id, code),
            KEY ix_mst_item_sub_classes_class (item_class_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    "mst_brand_manufacturers": """
        CREATE TABLE mst_brand_manufacturers (
            id BIGINT NOT NULL AUTO_INCREMENT,
            brand_id BIGINT NOT NULL,
            brand_code VARCHAR(10) NULL,
            brand_name VARCHAR(200) NULL,
            manufacturer_id BIGINT NOT NULL,
            manufacturer_code VARCHAR(10) NULL,
            manufacturer_name VARCHAR(200) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            PRIMARY KEY (id),
            UNIQUE KEY uq_brand_manufacturer (brand_id, manufacturer_id),
            KEY ix_brand_manufacturers_brand (brand_id),
            KEY ix_brand_manufacturers_manufacturer (manufacturer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
}

COLUMNS = {
    "mst_dosage_forms": {
        "description": "VARCHAR(300) NULL AFTER name",
    },
    "mst_item_categories": {
        "segment_code": "VARCHAR(2) NULL AFTER level",
    },
    "mst_items": {
        "general_name_id": "BIGINT NULL AFTER category_name",
        "general_name_code": "VARCHAR(10) NULL AFTER general_name_id",
        "general_name": "VARCHAR(200) NULL AFTER general_name_code",
        "brand_id": "BIGINT NULL AFTER general_name",
        "brand_code": "VARCHAR(10) NULL AFTER brand_id",
        "brand_name": "VARCHAR(200) NULL AFTER brand_code",
        "manufacturer_id": "BIGINT NULL AFTER brand_name",
        "manufacturer_code": "VARCHAR(10) NULL AFTER manufacturer_id",
        "manufacturer_name": "VARCHAR(200) NULL AFTER manufacturer_code",
        "item_class_id": "BIGINT NULL AFTER manufacturer_name",
        "item_class_code": "VARCHAR(10) NULL AFTER item_class_id",
        "item_class_name": "VARCHAR(200) NULL AFTER item_class_code",
        "item_sub_class_id": "BIGINT NULL AFTER item_class_name",
        "item_sub_class_code": "VARCHAR(10) NULL AFTER item_sub_class_id",
        "item_sub_class_name": "VARCHAR(200) NULL AFTER item_sub_class_code",
        "description": "TEXT NULL AFTER hsn_code",
        "has_components": "TINYINT(1) NOT NULL DEFAULT 0 AFTER description",
        "barcode_type": "VARCHAR(20) NULL AFTER has_components",
        "barcode_value": "VARCHAR(100) NULL AFTER barcode_type",
        "cgst_rate": "DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER tax_percent",
        "sgst_rate": "DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER cgst_rate",
        "igst_rate": "DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER sgst_rate",
        "has_expiry": "TINYINT(1) NOT NULL DEFAULT 0 AFTER is_serial_tracked",
        "requires_qi": "TINYINT(1) NOT NULL DEFAULT 0 AFTER has_expiry",
        "shelf_life_days": "INT NOT NULL DEFAULT 0 AFTER requires_qi",
        "safety_stock": "DECIMAL(16,3) NOT NULL DEFAULT 0 AFTER shelf_life_days",
        "reorder_level": "DECIMAL(16,3) NOT NULL DEFAULT 0 AFTER safety_stock",
        "reorder_qty": "DECIMAL(16,3) NOT NULL DEFAULT 0 AFTER reorder_level",
        "lead_time_days": "INT NOT NULL DEFAULT 0 AFTER reorder_qty",
        "min_order_qty": "DECIMAL(16,3) NOT NULL DEFAULT 0 AFTER lead_time_days",
        "max_order_qty": "DECIMAL(16,3) NOT NULL DEFAULT 0 AFTER min_order_qty",
        "purchase_price": "DECIMAL(16,4) NOT NULL DEFAULT 0 AFTER max_order_qty",
        "selling_price": "DECIMAL(16,4) NOT NULL DEFAULT 0 AFTER purchase_price",
        "mrp": "DECIMAL(16,4) NOT NULL DEFAULT 0 AFTER selling_price",
        "dosage_form_id": "BIGINT NULL AFTER mrp",
        "dosage_form_code": "VARCHAR(10) NULL AFTER dosage_form_id",
        "dosage_form_name": "VARCHAR(200) NULL AFTER dosage_form_code",
        "valuation_method": "VARCHAR(20) NOT NULL DEFAULT 'FIFO' AFTER dosage_form_name",
        "requires_special_storage": (
            "TINYINT(1) NOT NULL DEFAULT 0 AFTER valuation_method"
        ),
        "storage_conditions": "VARCHAR(300) NULL AFTER requires_special_storage",
        "requires_special_transport": (
            "TINYINT(1) NOT NULL DEFAULT 0 AFTER storage_conditions"
        ),
        "transport_conditions": "VARCHAR(300) NULL AFTER requires_special_transport",
    },
}

INDEXES = {
    "mst_item_categories": {
        "uq_mst_item_categories_path": "UNIQUE KEY uq_mst_item_categories_path (path)",
    },
    "mst_items": {
        "ix_mst_items_general_name_id": "KEY ix_mst_items_general_name_id (general_name_id)",
        "ix_mst_items_brand_id": "KEY ix_mst_items_brand_id (brand_id)",
        "ix_mst_items_manufacturer_id": "KEY ix_mst_items_manufacturer_id (manufacturer_id)",
        "ix_mst_items_item_class_id": "KEY ix_mst_items_item_class_id (item_class_id)",
        "ix_mst_items_item_sub_class_id": (
            "KEY ix_mst_items_item_sub_class_id (item_sub_class_id)"
        ),
        "ix_mst_items_dosage_form_id": "KEY ix_mst_items_dosage_form_id (dosage_form_id)",
    },
}


def connection():
    match = DSN.fullmatch(settings.DATABASE_URL)
    if not match:
        raise RuntimeError("This script requires a mysql+aiomysql DATABASE_URL")
    user, password, host, port, database = match.groups()
    return pymysql.connect(
        host=host, port=int(port), user=unquote(user), password=unquote(password),
        database=database, charset="utf8mb4", autocommit=False,
    )


def apply(check_only: bool = False) -> None:
    db = connection()
    try:
        with db.cursor() as cursor:
            for table, ddl in TABLES.items():
                cursor.execute(
                    "SELECT COUNT(*) FROM information_schema.tables "
                    "WHERE table_schema=DATABASE() AND table_name=%s", (table,),
                )
                exists = bool(cursor.fetchone()[0])
                print(f"{'OK' if exists else 'MISSING'} table {table}")
                if not exists and not check_only:
                    cursor.execute(ddl)

            for table, columns in COLUMNS.items():
                for column, ddl in columns.items():
                    cursor.execute(
                        "SELECT COUNT(*) FROM information_schema.columns "
                        "WHERE table_schema=DATABASE() AND table_name=%s "
                        "AND column_name=%s", (table, column),
                    )
                    exists = bool(cursor.fetchone()[0])
                    print(f"{'OK' if exists else 'MISSING'} column {table}.{column}")
                    if not exists and not check_only:
                        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

            if not check_only:
                cursor.execute(
                    "UPDATE mst_item_categories SET segment_code=RIGHT(path,2) "
                    "WHERE path IS NOT NULL AND segment_code IS NULL"
                )

            for table, indexes in INDEXES.items():
                for name, ddl in indexes.items():
                    cursor.execute(
                        "SELECT COUNT(*) FROM information_schema.statistics "
                        "WHERE table_schema=DATABASE() AND table_name=%s "
                        "AND index_name=%s", (table, name),
                    )
                    exists = bool(cursor.fetchone()[0])
                    print(f"{'OK' if exists else 'MISSING'} index {table}.{name}")
                    if not exists and not check_only:
                        cursor.execute(f"ALTER TABLE {table} ADD {ddl}")
            if not check_only:
                cursor.execute(
                    "SELECT id,code,name,manufacturer FROM mst_brands "
                    "WHERE manufacturer IS NOT NULL AND manufacturer<>''"
                )
                for brand_id, brand_code, brand_name, manufacturer_name in cursor.fetchall():
                    base = re.sub(r"[^A-Z0-9]", "", manufacturer_name.upper())[:10] or "MFR"
                    code, suffix = base, 1
                    while True:
                        cursor.execute(
                            "SELECT id,name FROM mst_manufacturers WHERE code=%s", (code,)
                        )
                        found = cursor.fetchone()
                        if not found or found[1].lower() == manufacturer_name.lower():
                            break
                        suffix += 1
                        tail = str(suffix)
                        code = f"{base[:10-len(tail)]}{tail}"
                    if not found:
                        cursor.execute(
                            "INSERT INTO mst_manufacturers(code,name) VALUES(%s,%s)",
                            (code, manufacturer_name),
                        )
                        manufacturer_id = cursor.lastrowid
                    else:
                        manufacturer_id = found[0]
                    cursor.execute(
                        "INSERT IGNORE INTO mst_brand_manufacturers"
                        "(brand_id,brand_code,brand_name,manufacturer_id,"
                        "manufacturer_code,manufacturer_name) VALUES(%s,%s,%s,%s,%s,%s)",
                        (brand_id, brand_code, brand_name, manufacturer_id,
                         code, manufacturer_name),
                    )
        if check_only:
            db.rollback()
        else:
            db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    apply("--check" in sys.argv)
