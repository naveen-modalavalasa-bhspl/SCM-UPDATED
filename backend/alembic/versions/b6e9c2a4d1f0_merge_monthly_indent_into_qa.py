"""Merge the monthly indent migrations with the current QA migration head.

Revision ID: b6e9c2a4d1f0
Revises: d4e6f8a2c0b1, f3d5a7c9e1b4
"""

from typing import Sequence, Union

revision: str = "b6e9c2a4d1f0"
down_revision: Union[str, Sequence[str], None] = (
    "d4e6f8a2c0b1",
    "f3d5a7c9e1b4",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
