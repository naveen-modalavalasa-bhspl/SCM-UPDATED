"""monthly indent settings and alert rules

Revision ID: f4b6c8d0e2a5
Revises: f3a5c7e9b1d4
Create Date: 2026-09-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f4b6c8d0e2a5"
down_revision: Union[str, Sequence[str], None] = "f3a5c7e9b1d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mi_settings",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("is_enabled", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("cycle_month_offset", sa.Integer(), server_default="0", nullable=False),
        sa.Column("start_day", sa.Integer(), server_default="1", nullable=False),
        sa.Column("end_day", sa.Integer(), server_default="31", nullable=False),
        sa.Column("timezone", sa.String(length=80), nullable=False),
        sa.Column("scheduler_enabled", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("scheduler_interval_minutes", sa.Integer(), server_default="30", nullable=False),
        sa.Column("updated_by_id", sa.BigInteger(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "mi_notification_rules",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("trigger_day", sa.Integer(), nullable=False),
        sa.Column("trigger_time", sa.Time(), nullable=False),
        sa.Column("target_type", sa.String(length=30), nullable=False),
        sa.Column("target_ref_id", sa.BigInteger(), nullable=False),
        sa.Column("target_name", sa.String(length=200), nullable=True),
        sa.Column("condition", sa.String(length=40), nullable=False),
        sa.Column("message_template", sa.Text(), nullable=False),
        sa.Column("escalation_enabled", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("escalation_day", sa.Integer(), nullable=True),
        sa.Column("escalation_time", sa.Time(), nullable=True),
        sa.Column("escalation_target_type", sa.String(length=30), nullable=True),
        sa.Column("escalation_target_ref_id", sa.BigInteger(), nullable=True),
        sa.Column("escalation_target_name", sa.String(length=200), nullable=True),
        sa.Column("escalation_message_template", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "mi_notification_logs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("rule_id", sa.BigInteger(), nullable=False),
        sa.Column("cycle_key", sa.String(length=40), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("target_employee_id", sa.BigInteger(), nullable=False),
        sa.Column("target_employee_name", sa.String(length=200), nullable=True),
        sa.Column("recipient_employee_id", sa.BigInteger(), nullable=False),
        sa.Column("recipient_employee_name", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.String(length=300), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "rule_id", "cycle_key", "target_employee_id", "recipient_employee_id", "kind",
            name="uq_mi_notification_once",
        ),
    )
    op.create_index("ix_mi_logs_cycle_rule", "mi_notification_logs", ["cycle_key", "rule_id"])
    op.create_index("ix_mi_notification_logs_rule_id", "mi_notification_logs", ["rule_id"])
    op.create_index("ix_mi_notification_logs_cycle_key", "mi_notification_logs", ["cycle_key"])
    op.create_index("ix_mi_notification_logs_target_employee_id", "mi_notification_logs", ["target_employee_id"])
    op.create_index("ix_mi_notification_logs_recipient_employee_id", "mi_notification_logs", ["recipient_employee_id"])
    op.create_index("ix_mi_notification_logs_sent_at", "mi_notification_logs", ["sent_at"])


def downgrade() -> None:
    op.drop_index("ix_mi_notification_logs_sent_at", table_name="mi_notification_logs")
    op.drop_index("ix_mi_notification_logs_recipient_employee_id", table_name="mi_notification_logs")
    op.drop_index("ix_mi_notification_logs_target_employee_id", table_name="mi_notification_logs")
    op.drop_index("ix_mi_notification_logs_cycle_key", table_name="mi_notification_logs")
    op.drop_index("ix_mi_notification_logs_rule_id", table_name="mi_notification_logs")
    op.drop_index("ix_mi_logs_cycle_rule", table_name="mi_notification_logs")
    op.drop_table("mi_notification_logs")
    op.drop_table("mi_notification_rules")
    op.drop_table("mi_settings")
