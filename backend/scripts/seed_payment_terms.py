"""Seed the business's standard payment terms (2026-10-06). Idempotent: a code that
already exists is left exactly as it is, so an admin's later edit is never undone.

    .venv/Scripts/python -m scripts.seed_payment_terms
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal, engine
import app.all_models  # noqa: F401
from app.shared.enums import PaymentSplitMode
from app.shared.models.master import PaymentTerm

# (code, name, advance %, delivery %, days after delivery — or "30,60,90" for the
#  delivery share in equal instalments, delivery_split = EQUAL)
TERMS = [
    ("ADV100", "Advance payment (100%)", 100, 0, 0),
    ("ADV30-D60", "30% advance / 70% in 60 days against delivery", 30, 70, 60),
    ("ADV50-D30-60-90", "50% advance / 50% in 30/60/90 days against delivery", 50, 50,
     "30,60,90"),
    ("CR15", "15 days credit", 0, 100, 15),
    ("CR30", "30 days credit", 0, 100, 30),
    ("CR45", "45 days credit", 0, 100, 45),
    ("CR60", "60 days credit", 0, 100, 60),
    ("CR90", "90 days credit", 0, 100, 90),
    ("ADV30-D180", "30% advance / 70% in 6 months against delivery", 30, 70, 180),
]


async def main() -> None:
    async with SessionLocal() as db:
        have = set((await db.execute(select(PaymentTerm.code))).scalars().all())
        added = 0
        for code, name, adv, dlv, days in TERMS:
            if code in have:
                continue
            schedule = days if isinstance(days, str) else None
            db.add(PaymentTerm(code=code, name=name, advance_pct=adv, advance_days=0,
                               advance_split=PaymentSplitMode.ONE.value,
                               delivery_pct=dlv,
                               delivery_days=(int(schedule.split(",")[0]) if schedule
                                              else days if dlv else 0),
                               delivery_split=(PaymentSplitMode.EQUAL.value if schedule
                                               else PaymentSplitMode.ONE.value),
                               delivery_instalment_days=schedule,
                               installation_split=PaymentSplitMode.ONE.value,
                               warranty_split=PaymentSplitMode.ONE.value,
                               installation_pct=0, installation_days=0,
                               warranty_pct=0, warranty_days=0, is_active=True))
            added += 1
        await db.commit()
        print(f"Payment terms: {added} added, {len(TERMS) - added} already there.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
