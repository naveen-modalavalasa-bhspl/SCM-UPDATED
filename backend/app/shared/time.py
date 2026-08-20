"""The one clock every module reads.

The app used to have three: `datetime.now(timezone.utc)` (models, audit, workflow),
`datetime.now()` (numbering) and MySQL's own `NOW()` (server defaults, report
windows). MySQL runs on IST and its DATETIME columns drop tzinfo, so a UTC write
landed 5h30 behind an IST write in the same table — which is why two screens
showed two different times for the same event.

Everything now writes **naive IST**: the wall clock the business runs on, in the
shape the column actually stores. Naive rather than aware on purpose — the value
read back from MySQL is naive, so writing aware would make a row's timestamp change
type depending on whether it came from the session or the database.

The one deliberate exception is `core/security.py`: a JWT `exp` is UTC by
specification and must stay UTC.
"""
from datetime import date, datetime, timedelta, timezone

#: India Standard Time. Fixed offset — India has no DST, so a full tz database is
#: not needed and `zoneinfo` (which needs tzdata installed on Windows) is avoided.
IST = timezone(timedelta(hours=5, minutes=30))


def now() -> datetime:
    """Current IST wall clock, naive — what every `created_at`/`updated_at` stores."""
    return datetime.now(IST).replace(tzinfo=None)


def today() -> date:
    """Today in IST. `date.today()` reads the process's clock, which is UTC on a
    server deployed abroad and would roll the date over at 05:30 local."""
    return now().date()


def not_in_past(value: date | None, label: str = "date") -> date | None:
    """Reject a date already gone, in IST. Returns the value so it can be a validator.

    Asking for delivery yesterday is not a request anybody can serve, and the browser
    guard (`min=` on the input) is a courtesy, not a control — the API takes whatever
    is posted to it.

    Deliberately used on CREATE schemas only. An existing document may legitimately
    carry a date that has since passed, and enforcing this on update would make every
    such document uneditable — a new rule cannot invalidate rows that were valid when
    they were written.
    """
    if value is not None and value < today():
        raise ValueError(f"{label} cannot be in the past")
    return value


def to_ist(value: datetime | None) -> datetime | None:
    """Normalises a timestamp for comparison against a stored one.

    An aware value (an HCM payload, an old UTC row someone re-read) is converted;
    a naive one is already IST by the rule above and is returned untouched.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(IST).replace(tzinfo=None)


def iso(value: datetime | None) -> str | None:
    """Serialises a stored timestamp for the browser, offset and all.

    The API used to hand out naive values stamped `Z`, so every screen rendered a
    stored IST time as if it were UTC and shifted it 5h30. Emitting `+05:30`
    instead means a browser anywhere renders the same wall clock the warehouse saw.
    """
    if value is None:
        return None
    stamped = value.replace(tzinfo=IST) if value.tzinfo is None else value.astimezone(IST)
    return stamped.isoformat()
