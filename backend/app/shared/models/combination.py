"""The combination columns every transaction line carries (2026-10-23).

An item is bought, stocked and issued as a COMBINATION — brand + variant + model
(`mst_item_combinations`). Each line table mixes this in, so a different combination
is a different row on every document. 0 and no name = none named. `combination_any`
is the indent's "any brand" — the warehouse then picks from what is in stock.
Names are snapshots, like every other name on a document.
"""
from sqlalchemy import BigInteger, Boolean, Column, String


class CombinationMixin:
    brand_id = Column(BigInteger, nullable=False, default=0, server_default="0")
    variant_id = Column(BigInteger, nullable=False, default=0, server_default="0")
    model_id = Column(BigInteger, nullable=False, default=0, server_default="0")
    brand_name = Column(String(200), nullable=True)
    variant_name = Column(String(200), nullable=True)
    model_name = Column(String(200), nullable=True)
    combination_any = Column(Boolean, nullable=False, default=False, server_default="0")


COMBINATION_COLUMNS = ("brand_id", "variant_id", "model_id", "brand_name",
                       "variant_name", "model_name", "combination_any")
