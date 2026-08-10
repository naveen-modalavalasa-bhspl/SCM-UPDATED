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
    """Identity for the whole system; there is no local users table.

    Never carries bank, salary, EPFO, health, PAN, Aadhaar, date of birth or gender —
    SCM reads none of it (rule 10). `raw` is filtered through mappers.scrub_raw()
    before it is written, so a sensitive field HCM adds later is dropped on arrival.
    """
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
    # An employee's HCM project, which is what stock raised by them defaults to.
    project_id = Column(BigInteger, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    raw = _raw()
    synced_at = _synced()


class HcmOffice(Base):
    __tablename__ = "hcm_offices"
    id = _pk()
    code = Column(String(50), nullable=True)
    name = Column(String(200), nullable=False, index=True)
    office_type = Column(String(50), nullable=True)      # HCM `level_name`
    # HCM's own `office_type`: what the place physically is — Mobile for an MMU
    # vehicle, Warehouse for a store. The column above holds the level and cannot be
    # reused: /api/auth/me has returned the level under that name since day one.
    office_mode = Column(String(50), nullable=True, index=True)
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
    # HCM runs one section per distribution rung ("L I P", "M.D.P"), so the section a
    # position sits in is what marks it as a stocking point. Indexed because the whole
    # LIP/MDP backfill is "every position in this section".
    section_id = Column(BigInteger, index=True, nullable=True)
    section_name = Column(String(200), nullable=True)
    office_id = Column(BigInteger, nullable=True)
    # HCM's own org role ("Network Technicians"), which is NOT an SCM permission role.
    # rbac_roles decides what someone may do; this describes what they are. Kept so
    # groups and rules can target the real org structure.
    role_id = Column(BigInteger, index=True, nullable=True)
    role_name = Column(String(200), nullable=True)
    job_name = Column(String(200), nullable=True)
    project_id = Column(BigInteger, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)
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
