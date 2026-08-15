"""The API console — build an API from the screen, for any application.

Register an outside system, issue it a key, then compose the endpoints it may read by
picking a table, its columns, optional joins and the filters that always apply. No
curated list of feeds and no per-consumer code: the source picker reads the live
database schema, so anything already in SCM can be served the day it is asked for.

Three constraints this module lives under, all deliberate:

  * **No tables of its own.** Clients, keys and endpoint definitions are JSON rows in
    `sys_settings` (`category='apis'`). Nothing to migrate, nothing to deploy.
  * **Read-only.** An API key can SELECT and nothing else. There is no code path in
    the console that writes to a business table. (An adapter may accept writes — see
    `adapters/` — and those land as documents in `sys_settings` too.)
  * **No system is named in the core.** `service.py`, `introspect.py` and `router.py`
    know about tables, columns, keys and scopes; they know nothing about who is
    calling. A consumer that needs a shape the builder cannot compose gets a package
    under `adapters/`, discovered at import — see `adapters/__init__.py`.

Permissions (`platform/rbac/permissions.py`): `integration.view`,
`integration.manage`, `integration.keys.manage`. Fail-closed — Admin on first start
and nobody else, until a job profile grants them.

Reachable at `/admin/integrations` (`admin_integrations` in `page_registry.PAGES`).
"""
