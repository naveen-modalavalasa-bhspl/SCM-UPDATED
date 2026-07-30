"""Add persistent application error logs and the admin navigation page.

Revision ID: f8a9b0c1d2e3
Revises: f7a8b9c0d1e2
"""
from alembic import op
import sqlalchemy as sa


revision = "f8a9b0c1d2e3"
down_revision = "f7a8b9c0d1e2"
branch_labels = None
depends_on = None

BigInt = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "sys_app_logs",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("level", sa.String(20), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("error_type", sa.String(200), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("http_method", sa.String(10), nullable=True),
        sa.Column("endpoint", sa.String(500), nullable=True),
        sa.Column("page_url", sa.String(1000), nullable=True),
        sa.Column("source_file", sa.String(500), nullable=True),
        sa.Column("function_name", sa.String(200), nullable=True),
        sa.Column("line_number", sa.Integer(), nullable=True),
        sa.Column("column_number", sa.Integer(), nullable=True),
        sa.Column("stack_trace", sa.Text(), nullable=True),
        sa.Column("actor_id", BigInt, nullable=True),
        sa.Column("actor_name", sa.String(200), nullable=True),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(500), nullable=True),
        sa.Column("context_data", sa.JSON(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sys_app_logs_request_id", "sys_app_logs", ["request_id"])
    op.create_index("ix_sys_app_logs_source", "sys_app_logs", ["source"])
    op.create_index("ix_sys_app_logs_level", "sys_app_logs", ["level"])
    op.create_index("ix_sys_app_logs_status_code", "sys_app_logs", ["status_code"])
    op.create_index("ix_sys_app_logs_actor_id", "sys_app_logs", ["actor_id"])
    op.create_index("ix_sys_app_logs_created_at", "sys_app_logs", ["created_at"])

    connection = op.get_bind()
    connection.execute(sa.text("""
        INSERT INTO rbac_pages
            (code, path, name, icon, module, parent_id, sort_order,
             required_permission, show_on_mobile, is_active)
        SELECT
            'admin_app_logs', '/admin/app-logs', 'App Logs', 'bug', 'admin',
            parent.id, 101, 'admin.audit.view', 1, 1
        FROM rbac_pages AS parent
        WHERE parent.code = 'grp_settings'
        ON DUPLICATE KEY UPDATE
            path = VALUES(path),
            name = VALUES(name),
            icon = VALUES(icon),
            module = VALUES(module),
            parent_id = VALUES(parent_id),
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            show_on_mobile = VALUES(show_on_mobile),
            is_active = VALUES(is_active)
    """))


def downgrade() -> None:
    op.execute("DELETE FROM rbac_pages WHERE code = 'admin_app_logs'")
    op.drop_index("ix_sys_app_logs_created_at", table_name="sys_app_logs")
    op.drop_index("ix_sys_app_logs_actor_id", table_name="sys_app_logs")
    op.drop_index("ix_sys_app_logs_status_code", table_name="sys_app_logs")
    op.drop_index("ix_sys_app_logs_level", table_name="sys_app_logs")
    op.drop_index("ix_sys_app_logs_source", table_name="sys_app_logs")
    op.drop_index("ix_sys_app_logs_request_id", table_name="sys_app_logs")
    op.drop_table("sys_app_logs")
