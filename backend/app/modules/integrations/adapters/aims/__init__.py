"""AIMS integration — SCM tells the asset system when asset stock arrives somewhere.

AIMS (the asset management application) already PULLS from SCM through ordinary
console-built endpoints under `/api/ext/v1/{slug}` with its own API key. What it could
not know without polling is *when* something changed. This adapter adds the PUSH:
every time an asset item's stock lands in a warehouse — a GRN is posted, or an indent /
issue / consignment is acknowledged at its destination — an event is written to an
outbox in the same transaction as the stock movement, then delivered to AIMS as a
signed, idempotent webhook after the transaction commits.

Owns no tables, like every adapter: the settings and the outbox are JSON documents in
`sys_settings` under `apis.aims.` (see `outbox.py`). It edits no other module; the
single line it depends on is `inventory.hooks.ON_STOCK_IN`, which it registers on at
import time. Nothing is recorded or sent until an administrator configures a target
URL, mints a secret and switches it on, so installing this changes nothing by itself.
"""
from app.modules.integrations.adapters import Adapter

ADAPTER = Adapter(
    key="aims",
    name="AIMS",
    description=("Asset management system. SCM pushes a signed event when asset stock "
                 "arrives at a warehouse; AIMS pulls details through its API key."),
    docs=None,
)
