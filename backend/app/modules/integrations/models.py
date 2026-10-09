"""No tables.

This module owns no schema. A client, a key and an endpoint definition are JSON
documents in `sys_settings` — see `store.py` — because the console has to be
deployable without a migration.

The file exists because every module has the same five (rule 1), and because a reader
looking for `api_*` tables should find the answer here rather than conclude they were
forgotten.
"""
