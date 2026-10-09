"""Module-local constants. Nothing here belongs in `shared/enums.py`: these describe
the console's own vocabulary, not a document status any other module reads.
"""
from enum import Enum


class KeyState(str, Enum):
    """What a key is, derived from its two timestamps — never stored.

    A stored state would have to be kept in step with `revoked_at` and `expires_at`
    by hand, and the day they disagree the console shows a key as live that the server
    refuses (or worse, the other way round).
    """
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


# The header an external application sends its key in.
API_KEY_HEADER = "X-API-Key"

# Slug rules for a UI-composed endpoint. Lowercase, hyphenated, no leading or trailing
# hyphen — it becomes a URL segment, so it has to survive being pasted into a browser,
# a curl command and a Java HTTP client without escaping.
SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$"

# A SQL identifier this module is willing to put into a statement. Everything the
# browser sends is matched against this BEFORE it is looked up in the schema, so a
# name carrying a quote or a semicolon is refused by shape, not by escaping.
IDENTIFIER_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"

# Page-size ceiling for an external puller. Higher than the internal MAX_PAGE_SIZE of
# 500 on purpose: a nightly sync pulling 90 rows in pages of 20 is round trips of
# overhead for nothing, and no person is waiting on the screen.
MAX_EXT_PAGE_SIZE = 2000

# How many calls per client the in-memory log keeps. The console has no table to write
# to, so usage is a ring buffer: it answers "what happened this morning" and forgets
# on restart. Said plainly on the Usage screen rather than implied.
CALL_LOG_SIZE = 500
