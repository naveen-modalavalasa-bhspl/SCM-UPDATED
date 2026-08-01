"""HCM payload mapping and the PII scrub. Pure functions, no database.

Sample shapes are taken from the live feed at HCM_BASE_URL/employees and /positions.
"""
from app.platform.hcm import mappers

EMPLOYEE_ROW = {
    "employee": {
        "id": 12290, "name": "B SATISH BABU", "employee_code": "HR-EMP-10807",
        "photo": None, "status": "Active", "dob": "2026-07-14", "gender": "Male",
        "pan_number": "HKEPB1234C", "aadhaar_number": "1234 5678 9012",
        "email": "satish@bhspl.in", "phone": "6309244150",
    },
    "position": {
        "id": 4501, "name": "Network Technician 4", "code": "NT@4-AP-104-MMUS",
        "role_name": "Network Technicians", "level_name": "Level-5", "level_rank": 5,
        "department": "Networking department", "section": "Networking",
        "reporting_to": [],
    },
    "project": {"id": 4, "name": "AP 104 - Mobile Medical Unit", "code": "AP-104-MMUS"},
    "office": {"id": 1, "name": "BAVYA HELTH SERVICE 104", "level": "HEAD OFFICE",
               "geo_location": {"state": "ANDHRA PRADESH", "district": "NTR"}},
    "bank_details": {"account_number": "123456789", "ifsc": "SBIN0001234"},
}

POSITION_ROW = {
    "id": 4501, "name": "Network Technician 4", "code": "NT@4-AP-104-MMUS",
    "office": 1, "department": 1579, "section": 2379, "role": 36, "job": 28,
    "office_id": 1, "department_id": 1579, "role_id": 36, "job_id": 28,
    "role_name": "Network Technicians", "job_name": "Physical maintenance",
    "project_name": "AP 104 - Mobile Medical Unit", "status": "Active",
    "reporting_to": [], "office_level_id": 3,
}


# ------------------------------ the PII scrub ------------------------------ #
def test_scrub_removes_bank_details_entirely():
    """Rule 10: bank data must never reach SCM, at any nesting depth."""
    cleaned = mappers.scrub_raw(EMPLOYEE_ROW)
    assert "bank_details" not in cleaned


def test_scrub_removes_national_id_numbers():
    cleaned = mappers.scrub_raw(EMPLOYEE_ROW)
    assert "pan_number" not in cleaned["employee"]
    assert "aadhaar_number" not in cleaned["employee"]


def test_scrub_removes_personal_attributes_scm_never_reads():
    cleaned = mappers.scrub_raw(EMPLOYEE_ROW)
    for field in ("dob", "gender", "photo"):
        assert field not in cleaned["employee"], field


def test_scrub_keeps_everything_scm_actually_uses():
    cleaned = mappers.scrub_raw(EMPLOYEE_ROW)
    assert cleaned["employee"]["name"] == "B SATISH BABU"
    assert cleaned["employee"]["employee_code"] == "HR-EMP-10807"
    assert cleaned["position"]["role_name"] == "Network Technicians"
    assert cleaned["project"]["id"] == 4
    assert cleaned["office"]["geo_location"]["state"] == "ANDHRA PRADESH"


def test_scrub_reaches_inside_lists():
    """A sensitive field inside a list of objects must go too."""
    payload = {"people": [{"name": "A", "pan_number": "X"}, {"name": "B"}]}
    assert mappers.scrub_raw(payload) == {"people": [{"name": "A"}, {"name": "B"}]}


def test_scrub_is_case_insensitive():
    assert mappers.scrub_raw({"Bank_Details": {"x": 1}, "keep": 2}) == {"keep": 2}


def test_scrub_does_not_mutate_the_caller_payload():
    payload = {"employee": {"pan_number": "X", "name": "A"}}
    mappers.scrub_raw(payload)
    assert payload["employee"]["pan_number"] == "X"


def test_scrub_passes_scalars_and_none_through():
    assert mappers.scrub_raw(None) is None
    assert mappers.scrub_raw("text") == "text"
    assert mappers.scrub_raw(7) == 7


# ------------------------------ employees ------------------------------ #
def test_map_employee_reads_the_nested_shape():
    cols = mappers.map_employee(EMPLOYEE_ROW)
    assert cols["id"] == 12290
    assert cols["emp_code"] == "HR-EMP-10807"
    assert cols["full_name"] == "B SATISH BABU"
    assert cols["office_id"] == 1
    assert cols["department_name"] == "Networking department"
    assert cols["is_active"] is True


def test_map_employee_captures_the_project():
    cols = mappers.map_employee(EMPLOYEE_ROW)
    assert cols["project_id"] == 4
    assert cols["project_name"] == "AP 104 - Mobile Medical Unit"


def test_map_employee_never_produces_a_sensitive_column():
    cols = mappers.map_employee(EMPLOYEE_ROW)
    for field in ("pan_number", "aadhaar_number", "dob", "gender", "bank_details"):
        assert field not in cols, field


def test_map_employee_marks_a_non_active_status_inactive():
    row = {"employee": {"id": 1, "name": "X", "status": "Resigned"}}
    assert mappers.map_employee(row)["is_active"] is False


def test_map_employee_survives_missing_blocks():
    """Not every employee has a project, position or office."""
    cols = mappers.map_employee({"employee": {"id": 5, "name": "Solo",
                                              "status": "Active"}})
    assert cols["id"] == 5
    assert cols["project_id"] is None
    assert cols["office_id"] is None


# ------------------------------ positions ------------------------------ #
def test_map_position_captures_the_hcm_org_role():
    """role_name is HCM's org role, deliberately separate from rbac_roles."""
    cols = mappers.map_position(POSITION_ROW)
    assert cols["role_id"] == 36
    assert cols["role_name"] == "Network Technicians"
    assert cols["job_name"] == "Physical maintenance"


def test_map_position_captures_the_project_name():
    assert mappers.map_position(POSITION_ROW)["project_name"] == \
        "AP 104 - Mobile Medical Unit"


def test_map_position_falls_back_to_the_unsuffixed_keys():
    """The feed sends both `role` and `role_id`; either alone must work."""
    row = dict(POSITION_ROW)
    del row["role_id"], row["department_id"], row["office_id"]
    cols = mappers.map_position(row)
    assert (cols["role_id"], cols["department_id"], cols["office_id"]) == (36, 1579, 1)


def test_map_position_takes_the_first_reporting_line_as_parent():
    row = dict(POSITION_ROW, reporting_to=[{"id": 99}, {"id": 100}])
    assert mappers.map_position(row)["parent_position_id"] == 99


# ------------------------------ projects ------------------------------ #
def test_map_project_uses_the_first_office_as_primary():
    row = {"id": 4, "name": "AP 104 - Mobile Medical Unit", "code": "AP-104-MMUS",
           "status": "Active",
           "assigned_offices_details": [
               {"id": 53, "name": "104-CIRCLE OFFICE-ZONE3"},
               {"id": 318, "name": "104-MMU-AP GOLUGONDA"}]}
    cols = mappers.map_project(row)
    assert (cols["id"], cols["code"]) == (4, "AP-104-MMUS")
    assert (cols["office_id"], cols["office_name"]) == (53, "104-CIRCLE OFFICE-ZONE3")
    assert cols["is_active"] is True


def test_map_project_handles_a_project_with_no_offices():
    cols = mappers.map_project({"id": 9, "name": "Unassigned"})
    assert cols["office_id"] is None
    assert cols["is_active"] is True     # absent status defaults to active
