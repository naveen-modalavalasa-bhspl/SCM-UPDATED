"""Returns — stock going back up the distribution chain.

A LIP sends expired or damaged material back to the MDP above it; that MDP sends it
on to the warehouse. `inventory.locations.classify()` already names this move
(`MovementKind.RETURN` — an upstream tier change) but nothing created a document for
it, so the goods travelled on a phone call and the stock never left the books.

This module is that document. It owns no tables: a return is a stock transfer with a
reason and a photograph, so it reuses `inv_sto`/`inv_sto_items` and tells its rows
apart by a marker on `remarks`. See `service.py` for why.
"""
