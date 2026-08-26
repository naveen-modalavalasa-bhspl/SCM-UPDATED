"""Hold a typed reset address until an admin confirms it belongs to that person.

`request_reset` finds an account by `hcm_employees.email`, and the rebuilt HCM serves
no employee email at all — the only address anywhere in its payload is
`position.reporting_to[0].employee_email`, which belongs to the person's MANAGER. All
1,933 mirrored employees therefore held NULL, every reset request matched nobody, and
the deliberate unconditional 204 made that indistinguishable from a mail that was sent
and lost.

Trusting the address the typist supplies would have been an account takeover: emp
codes are printed on every user list, approval and document, so anyone could enter
somebody else's code with their own address and be handed that person's reset link.
This table holds the FIRST address for an account until a human vouches for it.

Revision ID: e8f9a0b1c2d3
Revises: c22e205fa149
"""
from alembic import op
import sqlalchemy as sa


revision = "e8f9a0b1c2d3"
down_revision = "c22e205fa149"
branch_labels = None
depends_on = None

BigInt = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "sys_email_claims",
        sa.Column("id", BigInt, autoincrement=True, nullable=False),
        sa.Column("employee_id", BigInt, nullable=False),
        # Snapshots, so the queue reads as a person rather than an id even after a
        # sync re-keys the mirror (CLAUDE.md rule 10).
        sa.Column("employee_code", sa.String(50), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("status", sa.String(20), nullable=False,
                  server_default=sa.text("'PENDING'")),
        sa.Column("requested_ip", sa.String(45), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decided_by_id", BigInt, nullable=True),
        sa.Column("decided_by_name", sa.String(200), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    # Soft FK to hcm_employees, indexed and unconstrained (CLAUDE.md rule 10): a sync
    # may retire the employee, and the claim it decided must still be readable.
    op.create_index("ix_sys_email_claims_employee_id", "sys_email_claims",
                    ["employee_id"])
    op.create_index("ix_sys_email_claims_status", "sys_email_claims", ["status"])


def downgrade() -> None:
    op.drop_index("ix_sys_email_claims_status", table_name="sys_email_claims")
    op.drop_index("ix_sys_email_claims_employee_id", table_name="sys_email_claims")
    op.drop_table("sys_email_claims")
