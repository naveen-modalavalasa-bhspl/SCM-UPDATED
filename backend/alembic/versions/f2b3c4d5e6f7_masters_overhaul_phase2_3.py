"""masters overhaul phases 2 and 3 — tagging, packaging chain, kit components

Revision ID: f2b3c4d5e6f7
Revises: e1a2b3c4d5e6
Create Date: 2026-07-28

mst_category_tags replaces mst_attribute_mappings as the tagging surface. The old
table is left in place rather than dropped: it holds the mappings an admin already
entered, and the upgrade below copies them across so nothing has to be re-typed.
"""
import sqlalchemy as sa
from alembic import op

revision = "f2b3c4d5e6f7"
down_revision = "e1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mst_specs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("uom_id", sa.BigInteger(), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", name="uq_spec_code"),
        sa.ForeignKeyConstraint(["uom_id"], ["mst_uom.id"], name="fk_spec_uom"),
    )
    op.create_index("ix_mst_specs_uom_id", "mst_specs", ["uom_id"])

    op.create_table(
        "mst_category_tags",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("category_id", sa.BigInteger(), nullable=False),
        sa.Column("category_name", sa.String(200), nullable=True),
        sa.Column("tag_type", sa.String(20), nullable=False),
        sa.Column("tag_id", sa.BigInteger(), nullable=False),
        sa.Column("tag_code", sa.String(50), nullable=True),
        sa.Column("tag_name", sa.String(200), nullable=True),
        sa.Column("tag_uom_code", sa.String(20), nullable=True),
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("category_id", "tag_type", "tag_id", name="uq_category_tag"),
        sa.ForeignKeyConstraint(["category_id"], ["mst_item_categories.id"],
                                ondelete="CASCADE", name="fk_category_tag_category"),
    )
    op.create_index("ix_mst_category_tags_tag_id", "mst_category_tags", ["tag_id"])

    op.create_table(
        "mst_item_groups",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        # Soft FK to rbac_user_groups: shared must not depend on platform (rule 5).
        sa.Column("group_id", sa.BigInteger(), nullable=True),
        sa.Column("group_name", sa.String(200), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("item_id", "group_id", name="uq_item_group"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"], ondelete="CASCADE",
                                name="fk_item_group_item"),
    )
    op.create_index("ix_mst_item_groups_group_id", "mst_item_groups", ["group_id"])

    op.create_table(
        "mst_item_packaging",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("package_id", sa.BigInteger(), nullable=False),
        sa.Column("package_name", sa.String(200), nullable=True),
        sa.Column("quantity", sa.Numeric(16, 3), nullable=False, server_default="1"),
        sa.Column("uom_id", sa.BigInteger(), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("item_id", "level", name="uq_item_packaging_level"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"], ondelete="CASCADE",
                                name="fk_item_packaging_item"),
        sa.ForeignKeyConstraint(["package_id"], ["mst_packaging.id"],
                                name="fk_item_packaging_package"),
        sa.ForeignKeyConstraint(["uom_id"], ["mst_uom.id"], name="fk_item_packaging_uom"),
    )
    op.create_index("ix_mst_item_packaging_package_id", "mst_item_packaging",
                    ["package_id"])
    op.create_index("ix_mst_item_packaging_uom_id", "mst_item_packaging", ["uom_id"])

    op.create_table(
        "mst_item_components",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("component_item_id", sa.BigInteger(), nullable=False),
        sa.Column("component_code", sa.String(50), nullable=True),
        sa.Column("component_name", sa.String(300), nullable=True),
        sa.Column("quantity", sa.Numeric(16, 3), nullable=False, server_default="1"),
        sa.Column("uom_id", sa.BigInteger(), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"], ondelete="CASCADE",
                                name="fk_item_component_item"),
        sa.ForeignKeyConstraint(["component_item_id"], ["mst_items.id"],
                                name="fk_item_component_component"),
        sa.ForeignKeyConstraint(["uom_id"], ["mst_uom.id"], name="fk_item_component_uom"),
    )
    op.create_index("ix_mst_item_components_component", "mst_item_components",
                    ["component_item_id"])
    op.create_index("ix_mst_item_components_uom_id", "mst_item_components", ["uom_id"])

    op.add_column("mst_attributes", sa.Column("uom_id", sa.BigInteger(), nullable=True))
    op.add_column("mst_attributes", sa.Column("uom_code", sa.String(20), nullable=True))
    op.create_index("ix_mst_attributes_uom_id", "mst_attributes", ["uom_id"])
    op.create_foreign_key("fk_mst_attributes_uom", "mst_attributes", "mst_uom",
                          ["uom_id"], ["id"])
    # Free-text units become real UOM rows where the spelling already matches one.
    # Anything that does not match is left for an admin to fix rather than guessed at.
    #
    # Both sides carry an explicit COLLATE. The live database has mixed collations —
    # tables the DB team made are utf8mb4_unicode_ci, ones created since default to
    # utf8mb4_0900_ai_ci — and comparing across them raises 1267 rather than simply
    # not matching, which would abort the whole migration.
    op.execute("""
        UPDATE mst_attributes a
          JOIN mst_uom u
            ON LOWER(u.code) COLLATE utf8mb4_general_ci
             = LOWER(a.unit) COLLATE utf8mb4_general_ci
            OR LOWER(u.name) COLLATE utf8mb4_general_ci
             = LOWER(a.unit) COLLATE utf8mb4_general_ci
           SET a.uom_id = u.id, a.uom_code = u.code
         WHERE a.unit IS NOT NULL AND CHAR_LENGTH(TRIM(a.unit)) > 0
    """)

    # Carry the existing attribute mappings over. Only the CATEGORY ones: tagging is
    # to a category now, and an ITEM_CLASS mapping has no category to land on.
    op.execute("""
        INSERT INTO mst_category_tags
            (category_id, category_name, tag_type, tag_id, tag_code, tag_name,
             is_required, is_active)
        SELECT m.target_id, m.target_name, 'ATTRIBUTE', m.attribute_id,
               m.attribute_code, m.attribute_name, m.is_required, m.is_active
          FROM mst_attribute_mappings m
          JOIN mst_item_categories c ON c.id = m.target_id
         WHERE m.target_type = 'CATEGORY'
    """)


def downgrade() -> None:
    op.drop_constraint("fk_mst_attributes_uom", "mst_attributes", type_="foreignkey")
    op.drop_index("ix_mst_attributes_uom_id", table_name="mst_attributes")
    op.drop_column("mst_attributes", "uom_code")
    op.drop_column("mst_attributes", "uom_id")
    op.drop_table("mst_item_components")
    op.drop_table("mst_item_packaging")
    op.drop_table("mst_item_groups")
    op.drop_table("mst_category_tags")
    op.drop_table("mst_specs")
