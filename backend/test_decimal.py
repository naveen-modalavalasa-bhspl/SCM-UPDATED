import json
from decimal import Decimal
from pydantic import BaseModel

class TestModel(BaseModel):
    val1: Decimal
    val2: Decimal

m = TestModel(val1=Decimal("12.5000"), val2=Decimal("12.50"))
print(m.model_dump_json())
