from pydantic import BaseModel


class InventoryOverviewOut(BaseModel):
    module: str
    status: str
    database_ready: bool
