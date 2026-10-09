"""repair imported UOM classes and HSN links

Revision ID: a3c4d5e6f7a8
Revises: f2b3c4d5e6f7
Create Date: 2026-07-28

The live import already had item.hsn_code snapshots, but mst_hsn_codes was empty
and item.hsn_id was NULL. Preserve those codes by turning them into master rows,
then link each item to the matching row. Rows with no HSN snapshot get a visible
pending classification row rather than a guessed tax code.
"""
from alembic import op

revision = "a3c4d5e6f7a8"
down_revision = "f2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE mst_uom
           SET uom_class = CASE
                 WHEN LOWER(TRIM(code)) IN ('kg', 'g', 'gm', 'gram', 'grams')
                   OR LOWER(TRIM(name)) IN ('kg', 'kilogram', 'kilograms',
                                            'g', 'gram', 'grams')
                   THEN 'WEIGHT'
                 WHEN LOWER(TRIM(code)) IN ('lt', 'ltr', 'l', 'ml')
                   OR LOWER(TRIM(name)) IN ('litre', 'litres', 'liter', 'liters',
                                            'millilitre', 'millilitres',
                                            'milliliter', 'milliliters',
                                            'millileters')
                   THEN 'VOLUME'
                 WHEN LOWER(TRIM(code)) IN ('c', 'cel')
                   OR LOWER(TRIM(name)) IN ('centigrade', 'celsius')
                   THEN 'TEMPERATURE'
                 WHEN LOWER(TRIM(code)) IN ('pack', 'pkt', 'box', 'tray', 'cont')
                   OR LOWER(TRIM(name)) IN ('pack', 'packet', 'box', 'tray',
                                            'container')
                   THEN 'PACKAGING'
                 ELSE 'COUNT'
               END
    """)
    op.execute("""
        UPDATE mst_uom
           SET name = CASE
                 WHEN LOWER(TRIM(code)) = 'nos' THEN 'Numbers'
                 WHEN LOWER(TRIM(code)) = 'pack' THEN 'Pack'
                 WHEN LOWER(TRIM(code)) = 'kg' THEN 'Kilograms'
                 WHEN LOWER(TRIM(code)) IN ('g', 'gm') THEN 'Grams'
                 WHEN LOWER(TRIM(code)) IN ('lt', 'ltr', 'l') THEN 'Litres'
                 WHEN LOWER(TRIM(code)) = 'ml' THEN 'Millilitres'
                 WHEN LOWER(TRIM(code)) IN ('c', 'cel') THEN 'Centigrade'
                 ELSE name
               END
    """)

    op.execute("""
        INSERT INTO mst_hsn_codes
            (code, description, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
        SELECT DISTINCT TRIM(i.hsn_code),
               'Imported from existing item master - verify GST rates',
               0, 0, 0, 0, TRUE
          FROM mst_items i
         WHERE i.hsn_code IS NOT NULL
           AND CHAR_LENGTH(TRIM(i.hsn_code)) BETWEEN 4 AND 8
           AND TRIM(i.hsn_code) REGEXP '^[0-9]+$'
           AND NOT EXISTS (
               SELECT 1
                 FROM mst_hsn_codes h
                WHERE h.code COLLATE utf8mb4_general_ci
                    = TRIM(i.hsn_code) COLLATE utf8mb4_general_ci
           )
    """)
    op.execute("""
        INSERT INTO mst_hsn_codes
            (code, description, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
        SELECT '00000000', 'Pending HSN classification - verify before purchase',
               0, 0, 0, 0, TRUE
         WHERE NOT EXISTS (
               SELECT 1
                 FROM mst_hsn_codes h
                WHERE h.code COLLATE utf8mb4_general_ci = '00000000'
           )
    """)
    op.execute("""
        UPDATE mst_items i
          JOIN mst_hsn_codes h
            ON h.code COLLATE utf8mb4_general_ci
             = TRIM(i.hsn_code) COLLATE utf8mb4_general_ci
           SET i.hsn_id = h.id
         WHERE i.hsn_id IS NULL
           AND i.hsn_code IS NOT NULL
           AND CHAR_LENGTH(TRIM(i.hsn_code)) BETWEEN 4 AND 8
           AND TRIM(i.hsn_code) REGEXP '^[0-9]+$'
    """)
    op.execute("""
        UPDATE mst_items i
          JOIN mst_hsn_codes h
            ON h.code COLLATE utf8mb4_general_ci = '00000000'
           SET i.hsn_id = h.id,
               i.hsn_code = h.code
         WHERE i.hsn_id IS NULL
    """)
    op.execute("""
        UPDATE mst_items i
          JOIN mst_uom u ON u.id = i.uom_id
           SET i.uom_code = u.code
         WHERE i.uom_id IS NOT NULL
    """)


def downgrade() -> None:
    # Data-only repair. Do not unlink items or delete tax-classification rows on
    # downgrade, because an admin may have edited rates/descriptions after upgrade.
    pass
