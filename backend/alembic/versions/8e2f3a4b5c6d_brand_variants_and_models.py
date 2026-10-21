"""Brand variants and models (2026-10-16).

`mst_brand_variants` (Brand → Variant) and `mst_brand_models` (Brand → Variant →
Model), managed on Masters › Brands › Variants / Models. Codes are unique within
the parent. Idempotent, like its neighbours.

Revision ID: 8e2f3a4b5c6d
Revises: 7d1e2f3a4b5c
"""
from alembic import op
import sqlalchemy as sa

revision = "8e2f3a4b5c6d"
down_revision = "7d1e2f3a4b5c"
branch_labels = None
depends_on = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _common() -> list:
    return [
        sa.Column("id", sa.BigInteger(),
                  primary_key=True, autoincrement=True),
        sa.Column("brand_id", sa.BigInteger(), sa.ForeignKey("mst_brands.id"),
                  nullable=False, index=True),
        sa.Column("brand_code", sa.String(50), nullable=True),
        sa.Column("brand_name", sa.String(200), nullable=True),
    ]


def _tail() -> list:
    return [
        sa.Column("code", sa.String(20), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(300), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    ]


def upgrade() -> None:
    tables = _tables()
    if "mst_brand_variants" not in tables:
        op.create_table(
            "mst_brand_variants", *_common(), *_tail(),
            sa.UniqueConstraint("brand_id", "code", name="uq_brand_variant_code"),
        )
    if "mst_brand_models" not in tables:
        op.create_table(
            "mst_brand_models", *_common(),
            sa.Column("variant_id", sa.BigInteger(),
                      sa.ForeignKey("mst_brand_variants.id"), nullable=False, index=True),
            sa.Column("variant_code", sa.String(20), nullable=True),
            sa.Column("variant_name", sa.String(200), nullable=True),
            *_tail(),
            sa.UniqueConstraint("variant_id", "code", name="uq_brand_model_code"),
        )


def downgrade() -> None:
    tables = _tables()
    if "mst_brand_models" in tables:
        op.drop_table("mst_brand_models")
    if "mst_brand_variants" in tables:
        op.drop_table("mst_brand_variants")
