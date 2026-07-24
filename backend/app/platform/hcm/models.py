"""hcm_ tables — mapped to the canonical scm_rebuild schema. READ-ONLY (sync.py only)."""
from sqlalchemy import JSON, BigInteger, Boolean, Column, Date, DateTime, Integer, String

from app.core.database import Base


def _pk():
    return Column(BigInteger, primary_key=True, autoincrement=False)  # HCM's own id


def _raw():
    return Column(JSON, nullable=True)


def _synced():
    return Column(DateTime, nullable=False)


class HcmEmployee(Base):
    __tablename__ = "hcm_employees"
    id = _pk()
    emp_code = Column(String(50), unique=True, nullable=True)
    full_name = Column(String(200), nullable=False, index=True)
    email = Column(String(200), nullable=True, index=True)
    mobile = Column(String(20), nullable=True)
    department_id = Column(BigInteger, index=True, nullable=True)
    department_name = Column(String(200), nullable=True)
    section_id = Column(BigInteger, nullable=True)
    office_id = Column(BigInteger, index=True, nullable=True)
    office_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    raw = _raw()
    synced_at = _synced()


class HcmOffice(Base):
    __tablename__ = "hcm_offices"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False, index=True)
    office_type = Column(String(50), nullable=True)
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    raw = _raw()
    synced_at = _synced()


class HcmFacilityType(Base):
    __tablename__ = "hcm_facility_types"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmFacility(Base):
    __tablename__ = "hcm_facilities"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    facility_type_id = Column(BigInteger, nullable=True)
    office_id = Column(BigInteger, index=True, nullable=True)
    address = Column(String(500), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    is_stock_location = Column(Boolean, nullable=False, default=False, index=True)  # SCM-owned
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmDepartment(Base):
    __tablename__ = "hcm_departments"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    office_id = Column(BigInteger, index=True, nullable=True)
    head_employee_id = Column(BigInteger, index=True, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmSection(Base):
    __tablename__ = "hcm_sections"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    department_id = Column(BigInteger, index=True, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmPositionLevel(Base):
    __tablename__ = "hcm_position_levels"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    level_order = Column(Integer, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmPosition(Base):
    __tablename__ = "hcm_positions"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False)
    level_id = Column(BigInteger, index=True, nullable=True)
    parent_position_id = Column(BigInteger, index=True, nullable=True)
    department_id = Column(BigInteger, index=True, nullable=True)
    office_id = Column(BigInteger, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()


class HcmPositionAssignment(Base):
    __tablename__ = "hcm_position_assignments"
    id = _pk()
    employee_id = Column(BigInteger, index=True, nullable=False)
    employee_name = Column(String(200), nullable=True)
    position_id = Column(BigInteger, index=True, nullable=False)
    position_name = Column(String(200), nullable=True)
    department_id = Column(BigInteger, index=True, nullable=True)
    office_id = Column(BigInteger, nullable=True)
    is_primary = Column(Boolean, nullable=False, default=True)
    valid_from = Column(Date, index=True, nullable=True)
    valid_to = Column(Date, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    raw = _raw()
    synced_at = _synced()
