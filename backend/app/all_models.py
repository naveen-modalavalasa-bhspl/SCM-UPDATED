"""Imports every model module so Base.metadata knows all tables.

Used by Alembic (env.py) and the test suite (conftest). Import order is not
significant for metadata registration. Populated stage by stage.
"""
from app.core.database import Base  # noqa: F401

# Model modules are imported here as they are added (stage 2 onwards).
# Wrapped so the skeleton (stage 1) imports cleanly before models exist.
for _mod in (
    "app.shared.models.master",
    "app.shared.models.warehouse",
    "app.platform.hcm.models",
    "app.platform.rbac.models",
    "app.platform.workflow.models",
    "app.platform.rules.models",
    "app.platform.settings.models",
    "app.modules.indents.models",
    "app.modules.procurement.models",
    "app.modules.logistics.models",
):
    try:
        __import__(_mod)
    except ModuleNotFoundError:
        pass
