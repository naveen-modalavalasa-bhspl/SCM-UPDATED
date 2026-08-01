"""HCM JSON -> SCM columns. EVERY HCM field name in the system appears ONLY here.

When HCM renames a field, this is the one file to change. Mapped from the real
sample payloads in docs/hcm-samples/. Each mapper returns the column dict for the
matching hcm_* model (raw + synced_at are added by sync.py).

Note: the live HCM payloads are nested and denormalised differently from the doc's
assumptions (e.g. an employee's department arrives as a name on the position object,
not an id). We map what is present; the full payload is always kept in `raw`.
"""
from typing import Any

# Fields SCM must never store, at any nesting depth. Rule 10 forbids bank, salary,
# EPFO and health data; PAN, Aadhaar, DOB, gender and photo are personal data that no
# SCM feature reads, and keeping them would put national ID numbers in a supply-chain
# database for no reason. `raw` is passed through scrub_raw() before it is written.
SENSITIVE_FIELDS = frozenset({
    "bank_details", "bank_account", "account_number", "ifsc", "ifsc_code",
    "salary", "salary_details", "ctc", "gross_salary", "net_salary",
    "epfo", "pf_number", "uan", "esi_number",
    "health", "health_details", "medical", "blood_group",
    "pan_number", "pan", "aadhaar_number", "aadhaar",
    "dob", "date_of_birth", "gender", "photo",
})


def scrub_raw(value: Any) -> Any:
    """Strip sensitive keys from an HCM payload before it is persisted.

    Applied to the whole record, recursively, so a field HCM adds inside a new nested
    object is still caught. Returning a copy keeps the caller's dict intact.
    """
    if isinstance(value, dict):
        return {k: scrub_raw(v) for k, v in value.items()
                if k.lower() not in SENSITIVE_FIELDS}
    if isinstance(value, list):
        return [scrub_raw(v) for v in value]
    return value


def _active(status: Any) -> bool:
    return str(status).strip().lower() == "active"


def map_employee(row: dict) -> dict:
    """The /employees feed is one nested record per employee, not a flat row.

    Deliberately NOT mapped: pan_number, aadhaar_number, dob, gender, photo and
    bank_details. SCM reads none of them, and rule 10 forbids the last one outright.
    """
    emp = row.get("employee") or {}
    pos = row.get("position") or {}
    off = row.get("office") or {}
    prj = row.get("project") or {}
    return {
        "id": emp.get("id"),
        "emp_code": emp.get("employee_code"),
        "full_name": emp.get("name"),
        "email": emp.get("email"),
        "mobile": emp.get("phone"),
        "department_id": pos.get("department_id"),   # usually absent on this endpoint
        "department_name": pos.get("department"),    # name string on the position
        "section_id": pos.get("section_id"),
        "office_id": off.get("id"),
        "office_name": off.get("name"),
        "project_id": prj.get("id"),
        "project_name": prj.get("name"),
        "is_active": _active(emp.get("status")),
    }


def map_project(row: dict) -> dict:
    """HCM /projects -> mst_projects. Projects own stock; items stay project-agnostic.

    assigned_offices_details is left in `raw` rather than mapped: a project spans many
    offices, and mst_projects.office_id holds only the primary one.
    """
    offices = row.get("assigned_offices_details") or []
    primary = offices[0] if offices and isinstance(offices[0], dict) else {}
    return {
        "id": row.get("id"),
        "code": row.get("code") or row.get("project_code"),
        "name": row.get("name") or row.get("project_name"),
        "office_id": primary.get("id"),
        "office_name": primary.get("name"),
        "start_date": row.get("start_date"),
        "end_date": row.get("end_date"),
        "is_active": _active(row.get("status", "active")),
    }


def map_office(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("code"),
        "name": row.get("name"),
        "office_type": row.get("level_name"),
        "address": row.get("address"),
        "city": row.get("district_name"),
        "state": row.get("state_name"),
        "is_active": _active(row.get("status")),
    }


def map_facility_type(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("project_code") or row.get("code"),
        "name": row.get("name"),
        "is_active": _active(row.get("status")),
    }


def map_facility(row: dict) -> dict:
    # is_stock_location is SCM-owned and intentionally NOT mapped here.
    return {
        "id": row.get("id"),
        "code": row.get("code"),
        "name": row.get("name"),
        "facility_type_id": row.get("facility_master") or row.get("facility_type_id"),
        "office_id": row.get("office") or row.get("office_id"),
        "address": row.get("address"),
        "is_active": _active(row.get("status")),
    }


def map_department(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("code"),
        "name": row.get("name"),
        "office_id": row.get("office"),
        "head_employee_id": row.get("head_employee_id"),  # absent on this endpoint today
        "is_active": _active(row.get("status")),
    }


def map_section(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("code"),
        "name": row.get("name"),
        "department_id": row.get("department"),
        "is_active": _active(row.get("status")),
    }


def map_position_level(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("level_code") or row.get("code"),
        "name": row.get("name"),
        "level_order": row.get("rank"),
        "is_active": True,
    }


def map_position(row: dict) -> dict:
    """`role_name` here is HCM's org role ("Network Technicians"), not an SCM
    permission role. rbac_roles says what someone may do; this says what they are.
    Both exist on purpose — do not map one onto the other."""
    reporting_to = row.get("reporting_to") or []
    parent = reporting_to[0] if reporting_to else None
    if isinstance(parent, dict):
        parent = parent.get("id")
    return {
        "id": row.get("id"),
        "code": row.get("code"),
        "name": row.get("name"),
        "level_id": row.get("level_id") or row.get("office_level_id"),
        "parent_position_id": parent,
        "department_id": row.get("department_id") or row.get("department"),
        "office_id": row.get("office_id") or row.get("office"),
        "role_id": row.get("role_id") or row.get("role"),
        "role_name": row.get("role_name"),
        "job_name": row.get("job_name"),
        "project_id": row.get("project_id") or row.get("project"),
        "project_name": row.get("project_name"),
        "is_active": _active(row.get("status")),
    }


def map_position_assignment(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "employee_id": row.get("employee") or row.get("employee_id"),
        "employee_name": row.get("employee_name"),
        "position_id": row.get("position") or row.get("position_id"),
        "position_name": row.get("position_name"),
        "department_id": row.get("department") or row.get("department_id"),
        "office_id": row.get("office") or row.get("office_id"),
        "is_primary": bool(row.get("is_primary", True)),
        "valid_from": row.get("valid_from") or row.get("start_date"),
        "valid_to": row.get("valid_to") or row.get("end_date"),
        "is_active": _active(row.get("status", "active")),
    }


def map_organization_level(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "code": row.get("level_code"),
        "name": row.get("name"),
        "level_order": row.get("rank"),
        "parent_id": row.get("parent"),
    }


def position_assignment_from_position(row: dict) -> dict | None:
    """The positions endpoint carries `assigned_employee` inline; HCM's own
    position-assignments feed is currently empty. Derive an assignment row from a
    position so routing has data. Assignment id is synthesised from the position id."""
    emp = row.get("assigned_employee")
    if not emp or not emp.get("id"):
        return None
    return {
        "id": row["id"],                # 1:1 with position for the derived case
        "employee_id": emp.get("id"),
        "employee_name": emp.get("name"),
        "position_id": row.get("id"),
        "position_name": row.get("name"),
        "department_id": row.get("department_id"),
        "office_id": row.get("office_id"),
        "is_primary": True,
        "valid_from": None,
        "valid_to": None,
        "is_active": _active(row.get("status", "active")),
    }
