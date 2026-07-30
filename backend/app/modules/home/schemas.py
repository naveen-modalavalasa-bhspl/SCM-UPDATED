"""API contract for the role-aware home dashboard."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


DateRange = Literal["week", "month", "quarter"]


class HomeKpi(BaseModel):
    key: str
    label: str
    value: int
    detail: str
    detail_tone: str = "brand"
    href: str
    icon: str
    tone: str = "brand"


class HomeAction(BaseModel):
    key: str
    label: str
    href: str
    icon: str
    tone: str = "brand"


class HomeModule(BaseModel):
    code: str
    name: str
    description: str
    href: str
    icon: str


class AttentionSummary(BaseModel):
    key: str
    label: str
    count: int
    href: str
    icon: str
    tone: str = "brand"


class RecentActivity(BaseModel):
    id: str
    title: str
    subtitle: str
    occurred_at: datetime
    href: str
    icon: str
    tone: str = "brand"


class HomeSummary(BaseModel):
    date_range: DateRange
    kpis: list[HomeKpi] = Field(default_factory=list)
    quick_actions: list[HomeAction] = Field(default_factory=list)
    modules: list[HomeModule] = Field(default_factory=list)
    needs_attention: list[AttentionSummary] = Field(default_factory=list)
    recent_activity: list[RecentActivity] = Field(default_factory=list)
