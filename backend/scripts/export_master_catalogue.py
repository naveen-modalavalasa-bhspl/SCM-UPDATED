"""Export a master-data catalogue to Excel, read from the live database.

    .venv/Scripts/python -m scripts.export_master_catalogue [output.xlsx]

The schema half is read from information_schema, so it can never drift from reality
the way a hand-maintained document would. The usage half — what a table is for, which
endpoint serves it, who consumes it — is curated below, because no database knows that.

Regenerate after any schema change; do not hand-edit the workbook.
"""
import re
import sys
from datetime import datetime
from urllib.parse import unquote

import pymysql
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

from app.core.config import settings

DSN = re.compile(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(.+)")

INK = "1F2937"
HEAD_BG = "1E3A5F"
GROUP_BG = "EEF2F7"
WARN_BG = "FEF3C7"
BAD_BG = "FEE2E2"
OK_BG = "DCFCE7"

# --------------------------------------------------------------------------- #
#  Curated metadata. The database cannot tell us any of this.
# --------------------------------------------------------------------------- #
TABLES: dict[str, dict] = {
    "mst_items": {
        "label": "Item Master",
        "group": "Core masters",
        "purpose": "Every stockable and consumable item. Project-agnostic on purpose: "
                   "ownership lives on the stock ledger, so stock moves between "
                   "projects without editing the item.",
        "owner": "shared/masters",
        "api": "/api/items",
        "perm": "master.item.manage",
        "screen": "Masters > Items",
        "consumers": "Indents, Procurement (PO lines), Inventory, Warehouse "
                     "(stk_balance, stk_ledger), BOMs",
        "status": "Live, in use",
        "notes": "category_id and uom_id are NOT NULL in the live table. "
                 "category_name and uom_code are snapshots written at save time so a "
                 "list renders from one query instead of joining two masters.",
    },
    "mst_item_categories": {
        "label": "Category & Sub-category Master",
        "group": "Core masters",
        "purpose": "Hierarchical classification for items. Self-referencing tree.",
        "owner": "shared/masters",
        "api": "/api/item-categories",
        "perm": "master.category.manage",
        "screen": "Masters > Categories",
        "consumers": "Items, rules engine (category_code conditions), reporting",
        "status": "Live, in use",
        "notes": "`level` is derived from the parent on save, never supplied. The API "
                 "rejects a parent that would create a loop.",
    },
    "mst_uom": {
        "label": "Unit of Measure Master",
        "group": "Core masters",
        "purpose": "Units items are counted in: pieces, kg, box, litre.",
        "owner": "shared/masters",
        "api": "/api/uom",
        "perm": "master.uom.manage",
        "screen": "Masters > UOM",
        "consumers": "Items, indent lines, PO lines, GRN, stock",
        "status": "Live, in use",
        "notes": "uom_class and decimal_places are NOT NULL with database defaults and "
                 "are deliberately NOT mapped in the ORM — mapping them and sending "
                 "None would override the default and raise error 1048.",
    },
    "mst_uom_conversions": {
        "label": "UOM Conversion Master",
        "group": "Core masters",
        "purpose": "How many of one unit fit in another. BOX -> PCS factor 12 means "
                   "one box is twelve pieces.",
        "owner": "shared/masters",
        "api": "/api/uom-conversions",
        "perm": "master.uom.manage",
        "screen": "Masters > Conversions",
        "consumers": "Procurement and Warehouse, when a PO unit differs from the "
                     "stocking unit",
        "status": "Live, 1 row",
        "notes": "Only the forward direction is stored; the reverse is 1/factor, so a "
                 "pair cannot disagree with itself. No is_active column exists, so "
                 "this master cannot be deactivated — the UI hides the button.",
    },
    "mst_vendors": {
        "label": "Vendor / Supplier Master",
        "group": "Core masters",
        "purpose": "Suppliers that purchase orders are raised against.",
        "owner": "shared/masters",
        "api": "/api/vendors",
        "perm": "master.vendor.manage",
        "screen": "Masters > Vendors",
        "consumers": "Procurement (PO, RFQ, quotations), GRN",
        "status": "Live, empty — awaiting data",
        "notes": "vendor_type is NOT NULL defaulting to 'MATERIAL' and is left "
                 "unmapped. The live table also carries pan, credit_limit, rating, "
                 "is_approved and is_blacklisted, which the app does not yet read.",
    },
    "mst_vendor_items": {
        "label": "Vendor Item Master",
        "group": "Core masters",
        "purpose": "Which vendor supplies which item, at what rate and lead time.",
        "owner": "shared/masters",
        "api": "not exposed yet",
        "perm": "master.vendor.manage",
        "screen": "—",
        "consumers": "Procurement, for preferred-vendor selection",
        "status": "Table exists, no API yet",
        "notes": "Modelled in the ORM but no endpoint. Phase 2 with the vendor screen.",
    },
    "mst_projects": {
        "label": "Project Master",
        "group": "Core masters",
        "purpose": "Projects own stock. Items stay project-agnostic and the project "
                   "dimension lives on the stock ledger, so a transfer between "
                   "projects never touches the item master.",
        "owner": "shared/masters",
        "api": "/api/projects",
        "perm": "master.project.manage",
        "screen": "Masters > Projects",
        "consumers": "Stock balance and ledger (project_id), indents, reporting",
        "status": "Live, synced from HRMS",
        "notes": "Identity (id, code, name, office) is refreshed from HCM /projects; "
                 "everything else is SCM's to edit. customer_*, manager_* and "
                 "budget_amount exist in the table but are not mapped.",
    },
    "mst_boms": {
        "label": "Bill of Materials",
        "group": "Not yet wired",
        "purpose": "Assembly definitions: which components make up a finished item.",
        "owner": "DB team",
        "api": "not exposed",
        "perm": "—",
        "screen": "—",
        "consumers": "Future manufacturing or kitting flows",
        "status": "In DB, NOT mapped in the ORM",
        "notes": "Created by the DB team. No model, no endpoint, no screen. Left alone "
                 "deliberately — out of scope for Admin & Masters.",
    },
    "mst_bom_items": {
        "label": "BOM Lines",
        "group": "Not yet wired",
        "purpose": "Component lines belonging to a BOM.",
        "owner": "DB team",
        "api": "not exposed",
        "perm": "—",
        "screen": "—",
        "consumers": "Future manufacturing or kitting flows",
        "status": "In DB, NOT mapped in the ORM",
        "notes": "As above.",
    },
    "mst_item_specs": {
        "label": "Item Specifications",
        "group": "Not yet wired",
        "purpose": "Free-form technical attributes per item.",
        "owner": "DB team",
        "api": "not exposed",
        "perm": "—",
        "screen": "—",
        "consumers": "Future item-detail screens, RFQ specifications",
        "status": "In DB, NOT mapped in the ORM",
        "notes": "The brief's 'item attributes' requirement would be served by this "
                 "table when someone wires it up.",
    },
    "whs_warehouses": {
        "label": "Warehouse Master (Location)",
        "group": "Location masters",
        "purpose": "Physical stocking points. This IS the location master — there is "
                   "no separate mst_locations, because the DB team already models "
                   "warehouses and bins here.",
        "owner": "shared/masters",
        "api": "/api/warehouses",
        "perm": "master.location.manage",
        "screen": "Masters > Warehouses",
        "consumers": "Stock balance and ledger, GRN, issues, transfers, "
                     "LOCATION user groups",
        "status": "Live, in use",
        "notes": "facility_id is a soft FK to the HCM mirror — indexed, no constraint, "
                 "because the mirror may lag. warehouse_type is NOT NULL defaulting "
                 "to 'MAIN'. is_bin_managed false means stock sits in bulk and "
                 "stk_balance.bin_id stays 0.",
    },
    "whs_bins": {
        "label": "Bin Master (Zones, racks, shelves)",
        "group": "Location masters",
        "purpose": "Storage locations inside a warehouse. Zone, rack and shelf are the "
                   "same table at different depths rather than three tables.",
        "owner": "shared/masters",
        "api": "/api/bins",
        "perm": "master.location.manage",
        "screen": "Masters > Bins",
        "consumers": "Stock balance and ledger (bin_id), picking, put-away",
        "status": "Live, in use",
        "notes": "`path` and `level` are derived from the parent on save, never "
                 "supplied. A parent must be in the same warehouse, and a parent that "
                 "would create a loop is rejected.",
    },
    "sys_doc_series": {
        "label": "Document Numbering Master",
        "group": "Configuration masters",
        "purpose": "Numbering sequence and format per document type: prefix, pattern, "
                   "counter and reset rule.",
        "owner": "platform/admin",
        "api": "/api/admin/doc-series",
        "perm": "admin.numbering.manage",
        "screen": "Masters > Numbering",
        "consumers": "Every document: indents, POs, GRNs, issues, via "
                     "shared/numbering.next_number()",
        "status": "Live, empty — create a series before raising documents",
        "notes": "pattern accepts {PREFIX}/{FY}/{SEQ:5} and {prefix}/{fy}/{num:04d}. "
                 "reset_policy NEVER|YEARLY|MONTHLY resets under the same row lock as "
                 "the increment. last_number is NOT editable through the API — "
                 "rewinding it would reissue a number a live document already carries.",
    },
    "rbac_roles": {
        "label": "Role Master (SCM permissions)",
        "group": "Access masters",
        "purpose": "What a user MAY DO. Distinct from the HRMS org role, which "
                   "describes what someone IS.",
        "owner": "platform/rbac",
        "api": "/api/admin/roles (read-only)",
        "perm": "admin.roles.manage",
        "screen": "Masters > Roles",
        "consumers": "Permission checks on every endpoint, user grants, ROLE groups",
        "status": "Live, 5 roles",
        "notes": "Seeded from scripts/seed.py. Permission codes live only in "
                 "platform/rbac/permissions.py and are never invented at runtime.",
    },
    "rbac_user_groups": {
        "label": "User Group Master",
        "group": "Access masters",
        "purpose": "Named sets of employees, grouped by SCM role, HRMS org role or "
                   "position; sub-groups narrow a parent by place.",
        "owner": "platform/admin",
        "api": "/api/admin/groups",
        "perm": "admin.groups.manage",
        "screen": "Admin > User Groups",
        "consumers": "Notification recipients, rules engine NOTIFY, approval routing",
        "status": "Live",
        "notes": "Membership is DERIVED at query time from role_id / position_id / "
                 "location_id — never stored — so an HRMS sync cannot leave a stale "
                 "roster. location_id points at whs_warehouses.id, not a location "
                 "table. A LOCATION sub-group intersects its parent.",
    },
    "rbac_user_group_members": {
        "label": "User Group Members (explicit)",
        "group": "Access masters",
        "purpose": "Manual additions layered on top of a group's derived membership.",
        "owner": "platform/admin",
        "api": "/api/admin/groups/{id}/members",
        "perm": "admin.groups.manage",
        "screen": "Admin > User Groups > Members",
        "consumers": "Group resolution",
        "status": "Live",
        "notes": "Additive only: it never removes someone the group's rule selects. "
                 "For exceptions, not for building a roster by hand.",
    },
}

COLUMN_NOTES: dict[tuple[str, str], str] = {
    ("mst_items", "category_name"): "Snapshot of the category at save time",
    ("mst_items", "uom_code"): "Snapshot of the UOM at save time",
    ("mst_items", "is_batch_tracked"): "Drives batch_id on stk_balance",
    ("mst_items", "is_serial_tracked"): "Reserved for serial tracking",
    ("mst_item_categories", "level"): "DERIVED from the parent; do not send",
    ("mst_item_categories", "path"): "Denormalised ancestry, maintained by the DB team",
    ("mst_uom", "uom_class"): "Unmapped in the ORM: NOT NULL with a DB default",
    ("mst_uom", "decimal_places"): "Unmapped in the ORM: NOT NULL with a DB default",
    ("mst_uom_conversions", "factor"): "How many to_uom in one from_uom. Must be > 0",
    ("mst_vendors", "vendor_type"): "Unmapped: NOT NULL, defaults to 'MATERIAL'",
    ("mst_projects", "status"): "Unmapped: NOT NULL, defaults to 'ACTIVE'",
    ("whs_warehouses", "facility_id"): "SOFT FK to hcm_facilities — indexed, no constraint",
    ("whs_warehouses", "warehouse_type"): "MAIN | TRANSIT | QUARANTINE | SCRAP",
    ("whs_warehouses", "is_bin_managed"): "False means bulk storage; bin_id stays 0",
    ("whs_bins", "path"): "DERIVED, e.g. A/A-01. Do not send",
    ("whs_bins", "level"): "DERIVED from the parent. Do not send",
    ("whs_bins", "bin_type"): "ZONE | RACK | SHELF | STORAGE | STAGING",
    ("sys_doc_series", "pattern"): "{PREFIX}/{FY}/{SEQ:5} or {prefix}/{fy}/{num:04d}",
    ("sys_doc_series", "last_number"): "NOT editable via the API — would reissue numbers",
    ("sys_doc_series", "reset_policy"): "NEVER | YEARLY | MONTHLY. NULL reads as NEVER",
    ("rbac_user_groups", "group_type"): "ROLE | HCM_ROLE | POSITION | LOCATION",
    ("rbac_user_groups", "role_id"): "rbac_roles.id for ROLE; hcm_positions.role_id for HCM_ROLE",
    ("rbac_user_groups", "location_id"): "whs_warehouses.id — there is no location table",
}


def connect():
    match = DSN.match(settings.DATABASE_URL)
    if not match:
        raise SystemExit("DATABASE_URL must be mysql+aiomysql://user:pw@host:port/db")
    user, password, host, port, database = match.groups()
    return pymysql.connect(host=host, port=int(port), user=unquote(user),
                           password=unquote(password), database=database,
                           connect_timeout=30,
                           cursorclass=pymysql.cursors.DictCursor), database


def is_mandatory(col: dict) -> str:
    """Mandatory = the caller must supply it. NOT NULL with a default is not."""
    if "auto_increment" in (col["EXTRA"] or ""):
        return "No (auto)"
    if col["IS_NULLABLE"] == "YES":
        return "No"
    if col["COLUMN_DEFAULT"] is not None:
        return f"No (default {col['COLUMN_DEFAULT']})"
    return "YES"


def style_header(ws, row=1, width_map=None):
    fill = PatternFill("solid", fgColor=HEAD_BG)
    for cell in ws[row]:
        cell.font = Font(bold=True, color="FFFFFF", size=11)
        cell.fill = fill
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 30
    ws.freeze_panes = ws.cell(row=row + 1, column=1)
    for i, width in enumerate(width_map or [], start=1):
        ws.column_dimensions[get_column_letter(i)].width = width


def add_table(ws, name, n_rows, n_cols):
    if n_rows < 1:
        return
    ref = f"A1:{get_column_letter(n_cols)}{n_rows + 1}"
    table = Table(displayName=name, ref=ref)
    table.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
    ws.add_table(table)


def build(schema: dict, database: str, out_path: str) -> None:
    wb = Workbook()

    # ---------------------------------------------------------------- README
    ws = wb.active
    ws.title = "README"
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 110
    ws["A1"] = "SCM ERP — Master Data Catalogue"
    ws["A1"].font = Font(bold=True, size=16, color=INK)
    ws["A2"] = f"Database {database} · generated {datetime.now():%Y-%m-%d %H:%M}"
    ws["A2"].font = Font(italic=True, color="6B7280")

    readme = [
        ("", ""),
        ("How to read this", ""),
        ("Sheets",
         "Overview = one row per master table. Columns = every column of every "
         "table. Relationships = foreign keys and soft links. Indexes = keys and "
         "uniqueness. API = the endpoints that serve each master. Gotchas = the "
         "traps that have already cost time on this project."),
        ("Mandatory",
         "'YES' means the caller must supply the value: NOT NULL with no default. "
         "A NOT NULL column that has a database default is not mandatory — and must "
         "NOT be mapped in the ORM without repeating that default, or the ORM sends "
         "an explicit NULL that overrides it and raises error 1048."),
        ("Source of truth",
         "The schema half of this workbook is read live from information_schema, so "
         "it cannot drift. The usage half is curated in "
         "scripts/export_master_catalogue.py. Regenerate rather than hand-editing:"),
        ("Regenerate",
         ".venv/Scripts/python -m scripts.export_master_catalogue"),
        ("", ""),
        ("Design rules behind these tables", ""),
        ("Items are project-agnostic",
         "mst_items has no project column. Ownership lives on the stock ledger "
         "(stk_balance / stk_ledger, keyed item + warehouse + bin + batch + project), "
         "so stock transfers between projects without touching the item master."),
        ("Deactivate, never delete",
         "Every master with an is_active column is deactivated by DELETE, not "
         "removed. Documents snapshot master names but still carry the id, so a hard "
         "delete would orphan them."),
        ("Snapshots over joins",
         "Masters copy their parent's display fields onto the row at write time "
         "(item.uom_code, warehouse.facility_name, bin.path). A list screen then "
         "renders from one query instead of a join per line."),
        ("Two kinds of role",
         "rbac_roles is what a user MAY DO (APPROVER, STORE). hcm_positions.role_name "
         "is the HRMS org role — what someone IS (\"Network Technicians\"). Both "
         "exist on purpose; neither replaces the other."),
        ("Derived membership",
         "rbac_user_groups stores a rule, not a roster. Members are resolved at query "
         "time, so an HRMS sync can never leave a stale list behind."),
    ]
    row = 4
    for label, text in readme:
        ws.cell(row=row, column=1, value=label).font = Font(bold=True, color=INK)
        cell = ws.cell(row=row, column=2, value=text)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        if text and len(text) > 90:
            ws.row_dimensions[row].height = 15 * (len(text) // 95 + 1)
        row += 1

    # -------------------------------------------------------------- Overview
    ws = wb.create_sheet("Overview")
    headers = ["Group", "Table", "Master", "Rows", "Purpose", "API endpoint",
               "Manage permission", "Screen", "Consumed by", "Owner module", "Status"]
    ws.append(headers)
    order = sorted(TABLES, key=lambda t: (TABLES[t]["group"], t))
    for name in order:
        meta = TABLES[name]
        info = schema.get(name)
        ws.append([meta["group"], name, meta["label"],
                   info["rows"] if info else "MISSING", meta["purpose"], meta["api"],
                   meta["perm"], meta["screen"], meta["consumers"], meta["owner"],
                   meta["status"]])
    style_header(ws, width_map=[18, 26, 32, 8, 62, 30, 24, 26, 46, 18, 30])
    for r in range(2, ws.max_row + 1):
        for c in (5, 9, 11):
            ws.cell(row=r, column=c).alignment = Alignment(wrap_text=True, vertical="top")
        status = str(ws.cell(row=r, column=11).value)
        if "NOT mapped" in status:
            ws.cell(row=r, column=11).fill = PatternFill("solid", fgColor=WARN_BG)
        elif "empty" in status or "no API" in status:
            ws.cell(row=r, column=11).fill = PatternFill("solid", fgColor=WARN_BG)
        else:
            ws.cell(row=r, column=11).fill = PatternFill("solid", fgColor=OK_BG)
        ws.row_dimensions[r].height = 58
    add_table(ws, "Overview", ws.max_row - 1, len(headers))

    # --------------------------------------------------------------- Columns
    ws = wb.create_sheet("Columns")
    headers = ["Table", "Master", "#", "Column", "Type", "Mandatory", "Default",
               "Key", "Extra", "Foreign key", "Notes"]
    ws.append(headers)
    for name in order:
        info = schema.get(name)
        if not info:
            continue
        meta = TABLES[name]
        fk_map = {f["COLUMN_NAME"]: f"{f['REFERENCED_TABLE_NAME']}.{f['REFERENCED_COLUMN_NAME']}"
                  for f in info["fks"]}
        for col in info["columns"]:
            note = COLUMN_NOTES.get((name, col["COLUMN_NAME"]), col["COLUMN_COMMENT"] or "")
            ws.append([name, meta["label"], col["ORDINAL_POSITION"], col["COLUMN_NAME"],
                       col["COLUMN_TYPE"], is_mandatory(col),
                       col["COLUMN_DEFAULT"] if col["COLUMN_DEFAULT"] is not None else "",
                       col["COLUMN_KEY"], col["EXTRA"],
                       fk_map.get(col["COLUMN_NAME"], ""), note])
    style_header(ws, width_map=[26, 30, 5, 26, 22, 22, 20, 7, 16, 26, 60])
    for r in range(2, ws.max_row + 1):
        ws.cell(row=r, column=11).alignment = Alignment(wrap_text=True, vertical="top")
        if ws.cell(row=r, column=6).value == "YES":
            ws.cell(row=r, column=6).fill = PatternFill("solid", fgColor=BAD_BG)
            ws.cell(row=r, column=6).font = Font(bold=True, color="991B1B")
        if ws.cell(row=r, column=8).value == "PRI":
            ws.cell(row=r, column=4).font = Font(bold=True)
    add_table(ws, "Columns", ws.max_row - 1, len(headers))

    # --------------------------------------------------------- Relationships
    ws = wb.create_sheet("Relationships")
    headers = ["From table", "From column", "References", "Kind", "Note"]
    ws.append(headers)
    for name in order:
        info = schema.get(name)
        if not info:
            continue
        for fk in info["fks"]:
            ws.append([name, fk["COLUMN_NAME"],
                       f"{fk['REFERENCED_TABLE_NAME']}.{fk['REFERENCED_COLUMN_NAME']}",
                       "Hard FK (enforced)", ""])
    soft = [
        ("whs_warehouses", "facility_id", "hcm_facilities.id", "Soft FK (indexed, no constraint)",
         "HCM mirror may lag behind, so a constraint would block valid writes"),
        ("whs_warehouses", "office_id", "hcm_offices.id", "Soft FK", "Derived from the facility"),
        ("whs_warehouses", "incharge_id", "hcm_employees.id", "Soft FK", "Warehouse in-charge"),
        ("mst_projects", "office_id", "hcm_offices.id", "Soft FK", "Primary office of the project"),
        ("rbac_user_groups", "role_id", "rbac_roles.id / hcm_positions.role_id", "Soft FK",
         "Which one depends on group_type: ROLE vs HCM_ROLE"),
        ("rbac_user_groups", "position_id", "hcm_positions.id", "Soft FK", "POSITION groups"),
        ("rbac_user_groups", "location_id", "whs_warehouses.id", "Soft FK",
         "LOCATION sub-groups. There is no location table"),
        ("rbac_user_group_members", "employee_id", "hcm_employees.id", "Soft FK", "Explicit member"),
        ("stk_balance", "item_id / warehouse_id / bin_id / project_id",
         "mst_items / whs_warehouses / whs_bins / mst_projects", "Soft FK",
         "The stock key. bin, batch and project use 0 for 'not set', never NULL"),
        ("stk_ledger", "item_id / warehouse_id / project_id",
         "mst_items / whs_warehouses / mst_projects", "Soft FK", "Append-only ledger"),
    ]
    for row_values in soft:
        ws.append(list(row_values))
    style_header(ws, width_map=[26, 42, 46, 32, 62])
    for r in range(2, ws.max_row + 1):
        ws.cell(row=r, column=5).alignment = Alignment(wrap_text=True, vertical="top")
    add_table(ws, "Relationships", ws.max_row - 1, len(headers))

    # --------------------------------------------------------------- Indexes
    ws = wb.create_sheet("Indexes")
    headers = ["Table", "Index", "Columns", "Unique", "Why"]
    ws.append(headers)
    why = {
        "PRIMARY": "Primary key",
        "uq_stk_balance_item_wh_bin_batch_proj":
            "The stock key: makes move_stock()'s locking upsert safe",
    }
    for name in order:
        info = schema.get(name)
        if not info:
            continue
        for idx in info["indexes"]:
            ws.append([name, idx["INDEX_NAME"], idx["cols"],
                       "Yes" if not idx["NON_UNIQUE"] else "",
                       why.get(idx["INDEX_NAME"],
                               "Uniqueness constraint" if not idx["NON_UNIQUE"]
                               else "Lookup / filter")])
    style_header(ws, width_map=[26, 44, 40, 9, 52])
    add_table(ws, "Indexes", ws.max_row - 1, len(headers))

    # ------------------------------------------------------------------- API
    ws = wb.create_sheet("API")
    headers = ["Master", "Method", "Endpoint", "Permission", "Notes"]
    ws.append(headers)
    for name in order:
        meta = TABLES[name]
        api = meta["api"]
        if not api.startswith("/api"):
            ws.append([meta["label"], "—", api, "—", meta["status"]])
            continue
        read_note = ("Any authenticated user — every module's dropdowns read masters")
        rows = [("GET", api, "authenticated", read_note + ". Supports ?search= &page= "
                                              "&size= &include_inactive="),
                ("POST", api, meta["perm"], "Create"),
                ("PUT", f"{api}/{{id}}", meta["perm"], "Update"),
                ("DELETE", f"{api}/{{id}}", meta["perm"],
                 "DEACTIVATES, never deletes — documents reference the id")]
        if name == "mst_uom_conversions":
            rows[3] = ("DELETE", f"{api}/{{id}}", meta["perm"],
                       "Returns 400: this table has no is_active column")
        if name == "rbac_roles":
            rows = [("GET", api, "authenticated", "Read-only. Roles are seeded")]
        for method, path, perm, note in rows:
            ws.append([meta["label"], method, path, perm, note])
    style_header(ws, width_map=[32, 9, 40, 26, 76])
    for r in range(2, ws.max_row + 1):
        ws.cell(row=r, column=5).alignment = Alignment(wrap_text=True, vertical="top")
    add_table(ws, "API", ws.max_row - 1, len(headers))

    # --------------------------------------------------------------- Gotchas
    ws = wb.create_sheet("Gotchas")
    headers = ["Area", "Trap", "What to do"]
    ws.append(headers)
    for area, trap, fix in [
        ("ORM mapping",
         "Mapping a column the live table does not have makes EVERY SELECT on that "
         "model fail with error 1054 (Unknown column).",
         "Map only the columns the app reads or writes. Verify with "
         ".venv/Scripts/python -m scripts.apply_admin_masters --check, which diffs "
         "every mapped model against the live schema."),
        ("ORM mapping",
         "Mapping a NOT NULL column that has a database default, without repeating "
         "the default on the model, sends an explicit NULL and raises error 1048.",
         "Leave it unmapped (mst_uom.decimal_places, mst_vendors.vendor_type) or "
         "repeat the default on the model (mst_item_categories.level)."),
        ("Testing",
         "pytest builds its schema from Base.metadata, not from migrations, so it "
         "stays green while the live app 500s on a column mismatch.",
         "Never treat a green pytest as proof the live schema matches. Run the "
         "--check script as well."),
        ("MySQL",
         "MySQL allows repeated NULLs inside a UNIQUE index, so a nullable dimension "
         "silently permits duplicate stock balance rows.",
         "bin_id, batch_id and project_id use 0 for 'not set', never NULL."),
        ("Numbering",
         "sys_doc_series.pattern defaults to {PREFIX}/{FY}/{SEQ:5}, which is not a "
         "Python format string. Older code formatted {prefix}/{fy}/{num} and silently "
         "fell back, ignoring the configured pattern.",
         "shared/numbering.render() normalises both styles. Do not add a third."),
        ("Numbering",
         "Editing last_number downwards would reissue a document number that a live "
         "document already carries.",
         "last_number is intentionally absent from the API payload."),
        ("Privacy",
         "The HCM employee feed carries pan_number, aadhaar_number, dob, gender and "
         "bank_details. Storing them breaches rule 10.",
         "mappers.scrub_raw() strips them recursively before anything is written. "
         "scripts/scrub_hcm_pii.py cleans historic rows."),
        ("Naming",
         "There is no mst_locations table. The location master is whs_warehouses "
         "plus whs_bins.",
         "rbac_user_groups.location_id points at whs_warehouses.id."),
        ("Deletion",
         "A hard delete orphans documents that reference a master by id.",
         "DELETE deactivates. Inactive rows return with ?include_inactive=true."),
    ]:
        ws.append([area, trap, fix])
    style_header(ws, width_map=[16, 74, 74])
    for r in range(2, ws.max_row + 1):
        for c in (2, 3):
            ws.cell(row=r, column=c).alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 62
    add_table(ws, "Gotchas", ws.max_row - 1, len(headers))

    thin = Side(style="thin", color="D1D5DB")
    for sheet in wb.worksheets[1:]:
        for row_cells in sheet.iter_rows(min_row=1, max_row=sheet.max_row):
            for cell in row_cells:
                cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)

    wb.save(out_path)


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "../docs/SCM_Master_Data_Catalogue.xlsx"
    conn, database = connect()
    schema = {}
    try:
        with conn.cursor() as cur:
            for name in TABLES:
                cur.execute(
                    "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,"
                    "COLUMN_KEY,EXTRA,COLUMN_COMMENT,ORDINAL_POSITION "
                    "FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION",
                    (database, name))
                columns = cur.fetchall()
                if not columns:
                    print(f"  ! {name} not found in {database}")
                    continue
                cur.execute(
                    "SELECT INDEX_NAME,NON_UNIQUE,"
                    "GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols "
                    "FROM information_schema.STATISTICS "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
                    "GROUP BY INDEX_NAME,NON_UNIQUE", (database, name))
                indexes = cur.fetchall()
                cur.execute(
                    "SELECT COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME "
                    "FROM information_schema.KEY_COLUMN_USAGE "
                    "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
                    "AND REFERENCED_TABLE_NAME IS NOT NULL", (database, name))
                fks = cur.fetchall()
                cur.execute(f"SELECT COUNT(*) n FROM {name}")
                schema[name] = {"columns": columns, "indexes": indexes, "fks": fks,
                                "rows": cur.fetchone()["n"]}
    finally:
        conn.close()

    build(schema, database, out_path)
    total = sum(len(v["columns"]) for v in schema.values())
    print(f"Wrote {out_path}")
    print(f"  {len(schema)} tables, {total} columns, read live from {database}")


if __name__ == "__main__":
    main()
