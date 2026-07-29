"""Warehouse module — the physical side of the business flow.

Owns what happens between a PO and stock, and between stock and a delivery:
gate entry, GRN, quality inspection, putaway, picking, issue, dispatch and
purchase return.

Tables are the DB team's, already live: `inb_*` (inward), `out_*` (outward),
`whs_*` (locations, putaway tasks, serials), `pro_returns` (vendor returns).
Nothing here creates or alters a table — the schema is frozen and this module maps
onto it.
"""
