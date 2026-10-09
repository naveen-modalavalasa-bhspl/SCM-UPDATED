"""Dashboard summary contract."""
from pydantic import BaseModel, Field


class HomeKpi(BaseModel):
    key: str
    label: str
    value: int | float
    tone: str = "neutral"


class AttentionItem(BaseModel):
    id: str
    title: str
    subtitle: str | None = None
    module: str
    href: str
    status: str | None = None
    priority: str | None = None
    count: int | None = None


class HomeSummary(BaseModel):
    role_context: list[str] = Field(default_factory=list)
    kpis: list[HomeKpi] = Field(default_factory=list)
    needs_attention: list[AttentionItem] = Field(default_factory=list)
    pending_approvals: list[AttentionItem] = Field(default_factory=list)
    open_indents: list[AttentionItem] = Field(default_factory=list)
    waiting_on_me: list[AttentionItem] = Field(default_factory=list)
    stock_below_reorder: list[AttentionItem] = Field(default_factory=list)
    mrs_waiting_procurement: list[AttentionItem] = Field(default_factory=list)
    pos_due: list[AttentionItem] = Field(default_factory=list)
    grns_pending_qc: list[AttentionItem] = Field(default_factory=list)
