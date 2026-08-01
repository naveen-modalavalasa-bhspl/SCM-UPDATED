"""Operational approval inbox and approval-time document edits.

This module owns no tables. It presents workflow tasks and coordinates an approver's
allowed edits with the document module that owns the underlying record.

Delegation is intentionally not exposed here. Existing delegation rows remain only
as historical data; disabling their use in the shared workflow resolver is an
integration task outside this module.
"""

