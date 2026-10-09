"""B-CAMS integration — the 14 read feeds and the 4 write endpoints of SCM_ASK.md.

Lives inside `integrations/` because it is the same feature the console is: an outside
application, an API key, and routes under `/api/ext/v1` that no employee session ever
touches. It owns no tables and edits no other module — the reads are SELECTs over the
live schema, and the writes are stored as documents in `sys_settings` (see
`ingest.py`), exactly the way a client, a key and an endpoint definition already are.

Why hand-written rather than composed in the console: the shapes B-CAMS pinned are
computed, not columnar — a warehouse `tier`, a material issue's destination (SCM keeps
it on the consignment, not on the issue), an indent line's issued quantity (a SUM over
the issue lines). The generic builder joins and filters columns; it cannot derive.

One adapter among however many, discovered by `integrations.adapters.discover()`.
Nothing outside this folder names B-CAMS.
"""
from app.modules.integrations.adapters import Adapter

ADAPTER = Adapter(
    key="cams",
    name="B-CAMS",
    description=("Bavya's clinic application. 14 read feeds and 5 write endpoints "
                 "with shapes the endpoint builder cannot compose."),
    docs="API.md",
)

