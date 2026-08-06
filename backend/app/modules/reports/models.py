"""Reports owns NO tables.

The module exists to read what the other modules already wrote — `ind_indents`,
`wf_actions`/`wf_instances`, `stk_ledger` and the warehouse documents. It never
writes, so there is no `rep_` prefix and no migration. The file is here because
every module has the same five files; keeping it empty is the statement that a
report must never invent its own copy of a number.

See `ledgers.py` for the query specs.
"""
