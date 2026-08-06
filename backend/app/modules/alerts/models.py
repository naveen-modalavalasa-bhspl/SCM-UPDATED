"""No tables.

The module is deliberately table-free. An alert is copy plus presentation rules,
not business state: nothing here is queried, reported on or audited, so a table
would only be a slower way to read a constant. Keeping it out of the schema also
keeps the `alt_` prefix unclaimed for the day alerts genuinely need to persist
(per-user "don't show again", say) — see CLAUDE.md rule 1 for the file contract
this stub satisfies.

Every alert definition lives in `service.CATALOG`.
"""
