# scm_rebuild — canonical DB schema (introspected)

83 tables. Generated from information_schema.

## fin_accounts
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- account_type  varchar(30)  MUL NOT NULL
- parent_id  bigint  MUL NULL
- path  varchar(500)  NULL
- is_group  tinyint(1)  NOT NULL
- is_active  tinyint(1)  NOT NULL

## fin_fiscal_years
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(10)  UNI NOT NULL
- start_date  date  NOT NULL
- end_date  date  NOT NULL
- is_closed  tinyint(1)  NOT NULL
- is_current  tinyint(1)  NOT NULL

## fin_invoice_items
- id  bigint  PRI NOT NULL auto_increment
- invoice_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- po_item_id  bigint  NULL
- receipt_item_id  bigint  NULL
- item_id  bigint  MUL NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- hsn_code  varchar(20)  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NOT NULL
- tax_percent  decimal(6,3)  NOT NULL
- tax_amount  decimal(16,2)  NOT NULL
- amount  decimal(16,2)  NOT NULL
- account_id  bigint  NULL
  FKs: invoice_id->fin_invoices.id

## fin_invoices
- id  bigint  PRI NOT NULL auto_increment
- invoice_no  varchar(50)  UNI NOT NULL
- invoice_type  varchar(30)  NOT NULL
- invoice_date  date  NOT NULL
- due_date  date  MUL NULL
- party_type  varchar(20)  MUL NOT NULL
- party_id  bigint  NOT NULL
- party_name  varchar(200)  NULL
- party_gstin  varchar(20)  NULL
- po_id  bigint  MUL NULL
- po_no  varchar(50)  NULL
- receipt_id  bigint  NULL
- grn_no  varchar(50)  NULL
- so_id  bigint  NULL
- vendor_invoice_no  varchar(50)  NULL
- currency  varchar(3)  NOT NULL
- sub_total  decimal(16,2)  NOT NULL
- discount_amount  decimal(16,2)  NOT NULL
- cgst_amount  decimal(16,2)  NOT NULL
- sgst_amount  decimal(16,2)  NOT NULL
- igst_amount  decimal(16,2)  NOT NULL
- tax_amount  decimal(16,2)  NOT NULL
- grand_total  decimal(16,2)  NOT NULL
- paid_amount  decimal(16,2)  NOT NULL
- balance_amount  decimal(16,2)  NOT NULL
- status  varchar(30)  MUL NOT NULL
- fiscal_year  varchar(10)  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## fin_ledger
- id  bigint  PRI NOT NULL auto_increment
- entry_no  varchar(50)  NULL
- posting_date  date  NOT NULL
- account_id  bigint  MUL NOT NULL
- account_code  varchar(50)  NULL
- account_name  varchar(200)  NULL
- party_type  varchar(20)  MUL NULL
- party_id  bigint  NULL
- party_name  varchar(200)  NULL
- debit  decimal(16,2)  NOT NULL
- credit  decimal(16,2)  NOT NULL
- ref_type  varchar(30)  MUL NULL
- ref_id  bigint  NULL
- ref_no  varchar(50)  NULL
- project_id  bigint  NULL
- cost_center  varchar(100)  NULL
- narration  varchar(500)  NULL
- fiscal_year  varchar(10)  MUL NULL
- created_by_id  bigint  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## hcm_departments
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- office_id  bigint  MUL NULL
- head_employee_id  bigint  MUL NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_employees
- id  bigint  PRI NOT NULL
- emp_code  varchar(50)  UNI NULL
- full_name  varchar(200)  MUL NOT NULL
- email  varchar(200)  MUL NULL
- mobile  varchar(20)  NULL
- department_id  bigint  MUL NULL
- department_name  varchar(200)  NULL
- section_id  bigint  NULL
- office_id  bigint  MUL NULL
- office_name  varchar(200)  NULL
- is_active  tinyint(1)  MUL NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_facilities
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- facility_type_id  bigint  NULL
- office_id  bigint  MUL NULL
- address  varchar(500)  NULL
- city  varchar(100)  NULL
- state  varchar(100)  NULL
- is_stock_location  tinyint(1)  MUL NOT NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_facility_types
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_offices
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  MUL NOT NULL
- office_type  varchar(50)  NULL
- address  varchar(500)  NULL
- city  varchar(100)  NULL
- state  varchar(100)  NULL
- is_active  tinyint(1)  MUL NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_position_assignments
- id  bigint  PRI NOT NULL
- employee_id  bigint  MUL NOT NULL
- employee_name  varchar(200)  NULL
- position_id  bigint  MUL NOT NULL
- position_name  varchar(200)  NULL
- department_id  bigint  MUL NULL
- office_id  bigint  NULL
- is_primary  tinyint(1)  NOT NULL
- valid_from  date  MUL NULL
- valid_to  date  NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_position_levels
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- level_order  int  NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_positions
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- level_id  bigint  MUL NULL
- parent_position_id  bigint  MUL NULL
- department_id  bigint  MUL NULL
- office_id  bigint  NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## hcm_sections
- id  bigint  PRI NOT NULL
- code  varchar(50)  NULL
- name  varchar(200)  NOT NULL
- department_id  bigint  MUL NULL
- is_active  tinyint(1)  NOT NULL
- raw  json  NULL
- synced_at  datetime  NOT NULL

## inb_inspection_items
- id  bigint  PRI NOT NULL auto_increment
- inspection_id  bigint  MUL NOT NULL
- receipt_item_id  bigint  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- batch_no  varchar(50)  NULL
- inspected_qty  decimal(16,3)  NOT NULL
- accepted_qty  decimal(16,3)  NOT NULL
- rejected_qty  decimal(16,3)  NOT NULL
- parameters  json  NULL
- result  varchar(20)  NOT NULL
- defect_type  varchar(100)  NULL
- remarks  varchar(500)  NULL
  FKs: inspection_id->inb_inspections.id

## inb_inspections
- id  bigint  PRI NOT NULL auto_increment
- inspection_no  varchar(50)  UNI NOT NULL
- inspection_date  date  NOT NULL
- receipt_id  bigint  MUL NULL
- grn_no  varchar(50)  NULL
- warehouse_id  bigint  NULL
- warehouse_name  varchar(200)  NULL
- vendor_id  bigint  NULL
- vendor_name  varchar(200)  NULL
- inspection_type  varchar(30)  NOT NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- passed_items  int  NOT NULL
- failed_items  int  NOT NULL
- inspector_id  bigint  NULL
- inspector_name  varchar(200)  NULL
- remarks  text  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## inb_receipt_items
- id  bigint  PRI NOT NULL auto_increment
- receipt_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- po_item_id  bigint  MUL NULL
- indent_id  bigint  NULL
- indent_no  varchar(50)  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- ordered_qty  decimal(16,3)  NOT NULL
- received_qty  decimal(16,3)  NOT NULL
- accepted_qty  decimal(16,3)  NOT NULL
- rejected_qty  decimal(16,3)  NOT NULL
- short_qty  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- amount  decimal(16,2)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- mfg_date  date  NULL
- expiry_date  date  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- qc_status  varchar(30)  MUL NOT NULL
- rejection_reason  varchar(300)  NULL
- remarks  varchar(500)  NULL
  FKs: item_id->mst_items.id, receipt_id->inb_receipts.id

## inb_receipts
- id  bigint  PRI NOT NULL auto_increment
- grn_no  varchar(50)  UNI NOT NULL
- receipt_type  varchar(30)  NOT NULL
- grn_date  date  NOT NULL
- po_id  bigint  MUL NULL
- po_no  varchar(50)  NULL
- transfer_id  bigint  NULL
- transfer_no  varchar(50)  NULL
- vendor_id  bigint  MUL NULL
- vendor_name  varchar(200)  NULL
- vendor_gstin  varchar(20)  NULL
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- project_id  bigint  NULL
- project_name  varchar(200)  NULL
- invoice_no  varchar(50)  NULL
- invoice_date  date  NULL
- invoice_amount  decimal(16,2)  NULL
- eway_bill_no  varchar(50)  NULL
- vehicle_no  varchar(50)  NULL
- transporter_name  varchar(200)  NULL
- lr_no  varchar(50)  NULL
- gate_entry_no  varchar(50)  NULL
- gate_entry_at  datetime  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- total_received_qty  decimal(16,3)  NOT NULL
- total_accepted_qty  decimal(16,3)  NOT NULL
- total_rejected_qty  decimal(16,3)  NOT NULL
- total_value  decimal(16,2)  NOT NULL
- is_stock_posted  tinyint(1)  MUL NOT NULL
- posted_at  datetime  NULL
- received_by_id  bigint  NULL
- received_by_name  varchar(200)  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## ind_indent_items
- id  bigint  PRI NOT NULL auto_increment
- indent_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- category_name  varchar(200)  NULL
- uom_id  bigint  NULL
- uom_code  varchar(20)  NULL
- requested_qty  decimal(16,3)  NOT NULL
- approved_qty  decimal(16,3)  NOT NULL
- reserved_qty  decimal(16,3)  NOT NULL
- issued_qty  decimal(16,3)  NOT NULL
- ordered_qty  decimal(16,3)  NOT NULL
- received_qty  decimal(16,3)  NOT NULL
- estimated_rate  decimal(16,4)  NULL
- estimated_amount  decimal(16,2)  NULL
- fulfillment_route  varchar(30)  MUL NOT NULL
- fulfillment_status  varchar(30)  MUL NOT NULL
- parent_line_id  bigint  MUL NULL
- reserved_at  datetime  NULL
- remarks  varchar(500)  NULL
  FKs: indent_id->ind_indents.id, item_id->mst_items.id, parent_line_id->ind_indent_items.id

## ind_indents
- id  bigint  PRI NOT NULL auto_increment
- indent_no  varchar(50)  UNI NOT NULL
- indent_type  varchar(30)  MUL NOT NULL
- indent_date  date  NOT NULL
- required_date  date  NULL
- priority  varchar(20)  NOT NULL
- requested_by_id  bigint  MUL NOT NULL
- requested_by_name  varchar(200)  NULL
- requested_by_code  varchar(50)  NULL
- position_id  bigint  NULL
- position_name  varchar(200)  NULL
- department_id  bigint  MUL NULL
- department_name  varchar(200)  NULL
- section_id  bigint  NULL
- office_id  bigint  NULL
- office_name  varchar(200)  NULL
- warehouse_id  bigint  MUL NULL
- warehouse_name  varchar(200)  NULL
- project_id  bigint  MUL NULL
- project_name  varchar(200)  NULL
- vehicle_id  bigint  NULL
- vehicle_number  varchar(50)  NULL
- bom_id  bigint  MUL NULL
- bom_name  varchar(200)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- approved_qty  decimal(16,3)  NOT NULL
- issued_qty  decimal(16,3)  NOT NULL
- ordered_qty  decimal(16,3)  NOT NULL
- estimated_value  decimal(16,2)  NOT NULL
- current_stage_name  varchar(200)  NULL
- current_approver_name  varchar(200)  NULL
- approved_by_name  varchar(200)  NULL
- approved_at  datetime  NULL
- rejected_reason  varchar(500)  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  MUL NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## mst_bom_items
- id  bigint  PRI NOT NULL auto_increment
- bom_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- category_name  varchar(200)  NULL
- uom_id  bigint  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- scrap_percent  decimal(6,3)  NOT NULL
- estimated_rate  decimal(16,4)  NULL
- estimated_amount  decimal(16,2)  NULL
- child_bom_id  bigint  MUL NULL
- is_optional  tinyint(1)  NOT NULL
- remarks  varchar(500)  NULL
  FKs: bom_id->mst_boms.id, child_bom_id->mst_boms.id, item_id->mst_items.id

## mst_boms
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  MUL NOT NULL
- name  varchar(200)  NOT NULL
- bom_type  varchar(30)  MUL NOT NULL
- version  varchar(20)  NOT NULL
- parent_item_id  bigint  MUL NULL
- parent_item_code  varchar(50)  NULL
- parent_item_name  varchar(300)  NULL
- output_qty  decimal(16,3)  NOT NULL
- output_uom_code  varchar(20)  NULL
- project_id  bigint  MUL NULL
- project_name  varchar(200)  NULL
- department_id  bigint  MUL NULL
- department_name  varchar(200)  NULL
- vehicle_type  varchar(50)  NULL
- description  varchar(500)  NULL
- total_items  int  NOT NULL
- estimated_cost  decimal(16,2)  NOT NULL
- is_default  tinyint(1)  NOT NULL
- is_active  tinyint(1)  NOT NULL
- effective_from  date  NULL
- effective_to  date  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP
  FKs: parent_item_id->mst_items.id

## mst_item_categories
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- parent_id  bigint  MUL NULL
- path  varchar(500)  MUL NULL
- level  int  NOT NULL
- is_active  tinyint(1)  NOT NULL

## mst_item_specs
- item_id  bigint  PRI NOT NULL
- description  text  NULL
- brand  varchar(100)  NULL
- model_no  varchar(100)  NULL
- part_no  varchar(100)  NULL
- manufacturer  varchar(200)  NULL
- specifications  json  NULL
- storage_conditions  varchar(300)  NULL
- shelf_life_days  int  NULL
- image_url  varchar(500)  NULL
  FKs: item_id->mst_items.id

## mst_items
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(300)  NOT NULL
- short_name  varchar(100)  NULL
- category_id  bigint  MUL NOT NULL
- category_name  varchar(200)  NULL
- uom_id  bigint  MUL NOT NULL
- uom_code  varchar(20)  NULL
- item_type  varchar(30)  MUL NOT NULL
- hsn_code  varchar(20)  NULL
- tax_percent  decimal(6,3)  NULL
- is_batch_tracked  tinyint(1)  NOT NULL
- is_serial_tracked  tinyint(1)  NOT NULL
- is_active  tinyint(1)  MUL NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP
  FKs: category_id->mst_item_categories.id, uom_id->mst_uom.id

## mst_projects
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- office_id  bigint  NULL
- office_name  varchar(200)  NULL
- customer_id  bigint  NULL
- customer_name  varchar(200)  NULL
- manager_id  bigint  NULL
- manager_name  varchar(200)  NULL
- start_date  date  NULL
- end_date  date  NULL
- budget_amount  decimal(16,2)  NULL
- status  varchar(30)  MUL NOT NULL
- is_active  tinyint(1)  NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## mst_uom
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(20)  UNI NOT NULL
- name  varchar(100)  NOT NULL
- uom_class  varchar(30)  NULL
- decimal_places  int  NOT NULL
- is_active  tinyint(1)  NOT NULL

## mst_uom_conversions
- id  bigint  PRI NOT NULL auto_increment
- from_uom_id  bigint  MUL NOT NULL
- to_uom_id  bigint  MUL NOT NULL
- factor  decimal(16,6)  NOT NULL
  FKs: from_uom_id->mst_uom.id, to_uom_id->mst_uom.id

## mst_vendor_items
- id  bigint  PRI NOT NULL auto_increment
- vendor_id  bigint  MUL NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- vendor_item_code  varchar(50)  NULL
- last_rate  decimal(16,4)  NULL
- lead_time_days  int  NULL
- min_order_qty  decimal(16,3)  NULL
- is_preferred  tinyint(1)  NOT NULL
  FKs: item_id->mst_items.id, vendor_id->mst_vendors.id

## mst_vendors
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- vendor_type  varchar(30)  NOT NULL
- contact_person  varchar(200)  NULL
- phone  varchar(20)  NULL
- email  varchar(200)  NULL
- address  varchar(500)  NULL
- city  varchar(100)  NULL
- state  varchar(100)  NULL
- pincode  varchar(10)  NULL
- gstin  varchar(20)  MUL NULL
- pan  varchar(20)  NULL
- payment_terms_days  int  NULL
- credit_limit  decimal(16,2)  NULL
- rating  decimal(4,2)  NULL
- is_approved  tinyint(1)  NOT NULL
- is_blacklisted  tinyint(1)  NOT NULL
- is_active  tinyint(1)  MUL NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## out_dispatch_events
- id  bigint  PRI NOT NULL auto_increment
- dispatch_id  bigint  MUL NOT NULL
- event_type  varchar(30)  MUL NOT NULL
- event_at  datetime  NOT NULL
- location_name  varchar(200)  NULL
- latitude  decimal(10,7)  NULL
- longitude  decimal(10,7)  NULL
- temperature_c  decimal(6,2)  NULL
- humidity_percent  decimal(6,2)  NULL
- is_breach  tinyint(1)  MUL NOT NULL
- notes  varchar(500)  NULL
- recorded_by_id  bigint  NULL
- recorded_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: dispatch_id->out_dispatches.id

## out_dispatch_items
- id  bigint  PRI NOT NULL auto_increment
- dispatch_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- package_id  bigint  MUL NULL
- indent_id  bigint  NULL
- indent_no  varchar(50)  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- serial_no  varchar(100)  NULL
- quantity  decimal(16,3)  NOT NULL
- delivered_qty  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- amount  decimal(16,2)  NULL
- remarks  varchar(500)  NULL
  FKs: dispatch_id->out_dispatches.id, item_id->mst_items.id

## out_dispatch_packages
- id  bigint  PRI NOT NULL auto_increment
- dispatch_id  bigint  MUL NOT NULL
- package_no  varchar(50)  NOT NULL
- package_type  varchar(30)  NULL
- barcode  varchar(100)  MUL NULL
- weight_kg  decimal(16,3)  NULL
- length_cm  decimal(10,2)  NULL
- width_cm  decimal(10,2)  NULL
- height_cm  decimal(10,2)  NULL
- is_fragile  tinyint(1)  NOT NULL
- is_temp_controlled  tinyint(1)  NOT NULL
- status  varchar(30)  NOT NULL
- packed_by_name  varchar(200)  NULL
- packed_at  datetime  NULL
  FKs: dispatch_id->out_dispatches.id

## out_dispatches
- id  bigint  PRI NOT NULL auto_increment
- dispatch_no  varchar(50)  UNI NOT NULL
- dispatch_type  varchar(30)  MUL NOT NULL
- dispatch_date  date  NOT NULL
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- to_warehouse_id  bigint  NULL
- to_warehouse_name  varchar(200)  NULL
- customer_id  bigint  MUL NULL
- customer_name  varchar(200)  NULL
- vendor_id  bigint  NULL
- vendor_name  varchar(200)  NULL
- project_id  bigint  NULL
- project_name  varchar(200)  NULL
- delivery_address  varchar(500)  NULL
- contact_person  varchar(200)  NULL
- contact_phone  varchar(20)  NULL
- ref_type  varchar(30)  MUL NULL
- ref_id  bigint  NULL
- ref_no  varchar(50)  NULL
- transport_mode  varchar(30)  NULL
- carrier_id  bigint  NULL
- carrier_name  varchar(200)  NULL
- vehicle_id  bigint  MUL NULL
- vehicle_number  varchar(50)  NULL
- driver_name  varchar(200)  NULL
- driver_phone  varchar(20)  NULL
- lr_no  varchar(50)  MUL NULL
- eway_bill_no  varchar(50)  NULL
- freight_amount  decimal(16,2)  NULL
- gate_pass_no  varchar(50)  NULL
- gate_out_at  datetime  NULL
- security_by_name  varchar(200)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- total_packages  int  NOT NULL
- total_weight_kg  decimal(16,3)  NULL
- total_value  decimal(16,2)  NOT NULL
- expected_delivery  date  NULL
- delivered_at  datetime  NULL
- acknowledged_by_name  varchar(200)  NULL
- acknowledged_at  datetime  NULL
- pod_url  varchar(500)  NULL
- current_approver_name  varchar(200)  NULL
- approved_by_name  varchar(200)  NULL
- approved_at  datetime  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## out_issue_items
- id  bigint  PRI NOT NULL auto_increment
- issue_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- indent_item_id  bigint  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- expiry_date  date  NULL
- requested_qty  decimal(16,3)  NOT NULL
- issued_qty  decimal(16,3)  NOT NULL
- returned_qty  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- amount  decimal(16,2)  NULL
- remarks  varchar(500)  NULL
  FKs: issue_id->out_issues.id, item_id->mst_items.id

## out_issues
- id  bigint  PRI NOT NULL auto_increment
- issue_no  varchar(50)  UNI NOT NULL
- issue_type  varchar(30)  MUL NOT NULL
- issue_date  date  NOT NULL
- indent_id  bigint  MUL NULL
- indent_no  varchar(50)  NULL
- picking_id  bigint  NULL
- pick_no  varchar(50)  NULL
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- department_id  bigint  MUL NULL
- department_name  varchar(200)  NULL
- project_id  bigint  NULL
- project_name  varchar(200)  NULL
- vehicle_id  bigint  MUL NULL
- vehicle_number  varchar(50)  NULL
- issued_to_id  bigint  NULL
- issued_to_name  varchar(200)  NULL
- direction  varchar(3)  NOT NULL
- original_issue_id  bigint  NULL
- original_issue_no  varchar(50)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- total_value  decimal(16,2)  NOT NULL
- is_stock_posted  tinyint(1)  MUL NOT NULL
- posted_at  datetime  NULL
- current_approver_name  varchar(200)  NULL
- approved_by_name  varchar(200)  NULL
- approved_at  datetime  NULL
- acknowledged_by_name  varchar(200)  NULL
- acknowledged_at  datetime  NULL
- issued_by_id  bigint  NULL
- issued_by_name  varchar(200)  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## out_picking
- id  bigint  PRI NOT NULL auto_increment
- pick_no  varchar(50)  UNI NOT NULL
- pick_date  date  NOT NULL
- warehouse_id  bigint  NOT NULL
- warehouse_name  varchar(200)  NULL
- ref_type  varchar(30)  MUL NOT NULL
- ref_id  bigint  NULL
- ref_no  varchar(50)  NULL
- strategy  varchar(20)  NOT NULL
- status  varchar(30)  MUL NOT NULL
- total_lines  int  NOT NULL
- picked_lines  int  NOT NULL
- assigned_to_id  bigint  MUL NULL
- assigned_to_name  varchar(200)  NULL
- started_at  datetime  NULL
- completed_at  datetime  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## out_picking_items
- id  bigint  PRI NOT NULL auto_increment
- picking_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- required_qty  decimal(16,3)  NOT NULL
- picked_qty  decimal(16,3)  NOT NULL
- status  varchar(30)  NOT NULL
- picked_by_id  bigint  NULL
- picked_at  datetime  NULL
  FKs: picking_id->out_picking.id

## pro_po_items
- id  bigint  PRI NOT NULL auto_increment
- po_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- requisition_item_id  bigint  NULL
- indent_id  bigint  MUL NULL
- indent_no  varchar(50)  NULL
- indent_item_id  bigint  NULL
- item_id  bigint  MUL NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- description  varchar(500)  NULL
- hsn_code  varchar(20)  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NOT NULL
- discount_percent  decimal(6,3)  NOT NULL
- discount_amount  decimal(16,2)  NOT NULL
- tax_percent  decimal(6,3)  NOT NULL
- tax_amount  decimal(16,2)  NOT NULL
- amount  decimal(16,2)  NOT NULL
- received_qty  decimal(16,3)  NOT NULL
- rejected_qty  decimal(16,3)  NOT NULL
- returned_qty  decimal(16,3)  NOT NULL
- expected_date  date  NULL
- status  varchar(30)  MUL NOT NULL
- remarks  varchar(500)  NULL
  FKs: po_id->pro_purchase_orders.id

## pro_purchase_orders
- id  bigint  PRI NOT NULL auto_increment
- po_no  varchar(50)  UNI NOT NULL
- po_type  varchar(30)  NOT NULL
- po_date  date  MUL NOT NULL
- expected_date  date  NULL
- vendor_id  bigint  MUL NOT NULL
- vendor_name  varchar(200)  NULL
- vendor_gstin  varchar(20)  NULL
- vendor_phone  varchar(20)  NULL
- requisition_id  bigint  MUL NULL
- requisition_no  varchar(50)  NULL
- quotation_id  bigint  NULL
- quotation_no  varchar(50)  NULL
- contract_id  bigint  NULL
- warehouse_id  bigint  MUL NULL
- warehouse_name  varchar(200)  NULL
- project_id  bigint  MUL NULL
- project_name  varchar(200)  NULL
- billing_address  varchar(500)  NULL
- shipping_address  varchar(500)  NULL
- currency  varchar(3)  NOT NULL
- sub_total  decimal(16,2)  NOT NULL
- discount_amount  decimal(16,2)  NOT NULL
- cgst_amount  decimal(16,2)  NOT NULL
- sgst_amount  decimal(16,2)  NOT NULL
- igst_amount  decimal(16,2)  NOT NULL
- tax_amount  decimal(16,2)  NOT NULL
- freight_amount  decimal(16,2)  NOT NULL
- grand_total  decimal(16,2)  NOT NULL
- payment_terms_days  int  NULL
- payment_terms  varchar(500)  NULL
- delivery_terms  varchar(500)  NULL
- status  varchar(30)  NOT NULL
- vendor_ack_status  varchar(30)  NOT NULL
- vendor_ack_date  datetime  NULL
- supplier_delivery_date  date  NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- received_qty  decimal(16,3)  NOT NULL
- invoiced_amount  decimal(16,2)  NOT NULL
- paid_amount  decimal(16,2)  NOT NULL
- current_stage_name  varchar(200)  NULL
- current_approver_name  varchar(200)  NULL
- approved_by_name  varchar(200)  NULL
- approved_at  datetime  NULL
- version_no  int  NOT NULL
- parent_po_id  bigint  MUL NULL
- base_po_no  varchar(50)  NULL
- is_current  tinyint(1)  MUL NOT NULL
- cancelled_by_id  bigint  NULL
- cancelled_by_name  varchar(200)  NULL
- cancelled_at  datetime  NULL
- cancel_reason  varchar(500)  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP
  FKs: parent_po_id->pro_purchase_orders.id, vendor_id->mst_vendors.id

## pro_quotation_items
- id  bigint  PRI NOT NULL auto_increment
- quotation_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- rfq_item_id  bigint  NULL
- item_id  bigint  MUL NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- description  varchar(500)  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NOT NULL
- discount_percent  decimal(6,3)  NULL
- tax_percent  decimal(6,3)  NULL
- amount  decimal(16,2)  NOT NULL
- delivery_days  int  NULL
  FKs: quotation_id->pro_quotations.id

## pro_quotations
- id  bigint  PRI NOT NULL auto_increment
- quotation_no  varchar(50)  UNI NOT NULL
- quotation_type  varchar(30)  NOT NULL
- rfq_id  bigint  MUL NULL
- rfq_no  varchar(50)  NULL
- vendor_id  bigint  MUL NOT NULL
- vendor_name  varchar(200)  NULL
- vendor_ref_no  varchar(50)  NULL
- quotation_date  date  NOT NULL
- valid_till  date  NULL
- currency  varchar(3)  NOT NULL
- sub_total  decimal(16,2)  NOT NULL
- discount_amount  decimal(16,2)  NOT NULL
- tax_amount  decimal(16,2)  NOT NULL
- freight_amount  decimal(16,2)  NOT NULL
- grand_total  decimal(16,2)  NOT NULL
- payment_terms  varchar(300)  NULL
- delivery_days  int  NULL
- status  varchar(30)  NOT NULL
- rank_position  int  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: vendor_id->mst_vendors.id

## pro_requisition_items
- id  bigint  PRI NOT NULL auto_increment
- requisition_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- indent_id  bigint  MUL NULL
- indent_no  varchar(50)  NULL
- indent_item_id  bigint  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- ordered_qty  decimal(16,3)  NOT NULL
- estimated_rate  decimal(16,4)  NULL
- estimated_amount  decimal(16,2)  NULL
- required_date  date  NULL
  FKs: item_id->mst_items.id, requisition_id->pro_requisitions.id

## pro_requisitions
- id  bigint  PRI NOT NULL auto_increment
- req_no  varchar(50)  UNI NOT NULL
- req_date  date  NOT NULL
- warehouse_id  bigint  NULL
- warehouse_name  varchar(200)  NULL
- project_id  bigint  NULL
- project_name  varchar(200)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- estimated_value  decimal(16,2)  NOT NULL
- current_approver_name  varchar(200)  NULL
- approved_by_name  varchar(200)  NULL
- approved_at  datetime  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## pro_return_items
- id  bigint  PRI NOT NULL auto_increment
- return_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- po_item_id  bigint  NULL
- grn_item_id  bigint  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- quantity  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- amount  decimal(16,2)  NULL
- reason  varchar(300)  NULL
  FKs: return_id->pro_returns.id

## pro_returns
- id  bigint  PRI NOT NULL auto_increment
- return_no  varchar(50)  UNI NOT NULL
- return_date  date  NOT NULL
- po_id  bigint  MUL NULL
- po_no  varchar(50)  NULL
- grn_id  bigint  NULL
- grn_no  varchar(50)  NULL
- vendor_id  bigint  MUL NOT NULL
- vendor_name  varchar(200)  NULL
- warehouse_id  bigint  NULL
- warehouse_name  varchar(200)  NULL
- reason  varchar(500)  NULL
- status  varchar(30)  NOT NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- total_value  decimal(16,2)  NOT NULL
- credit_note_no  varchar(50)  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## pro_rfq_items
- id  bigint  PRI NOT NULL auto_increment
- rfq_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- item_id  bigint  MUL NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- description  varchar(500)  NULL
- uom_code  varchar(20)  NULL
- quantity  decimal(16,3)  NOT NULL
- required_date  date  NULL
  FKs: rfq_id->pro_rfqs.id

## pro_rfq_vendors
- id  bigint  PRI NOT NULL auto_increment
- rfq_id  bigint  MUL NOT NULL
- vendor_id  bigint  MUL NOT NULL
- vendor_name  varchar(200)  NULL
- vendor_email  varchar(200)  NULL
- sent_at  datetime  NULL
- responded_at  datetime  NULL
- status  varchar(30)  NOT NULL
  FKs: rfq_id->pro_rfqs.id, vendor_id->mst_vendors.id

## pro_rfqs
- id  bigint  PRI NOT NULL auto_increment
- rfq_no  varchar(50)  UNI NOT NULL
- rfq_type  varchar(30)  MUL NOT NULL
- rfq_date  date  NOT NULL
- due_date  date  NULL
- requisition_id  bigint  NULL
- requisition_no  varchar(50)  NULL
- warehouse_id  bigint  NULL
- warehouse_name  varchar(200)  NULL
- project_id  bigint  NULL
- project_name  varchar(200)  NULL
- title  varchar(300)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- vendor_count  int  NOT NULL
- response_count  int  NOT NULL
- awarded_vendor_id  bigint  NULL
- awarded_vendor_name  varchar(200)  NULL
- terms  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## rbac_pages
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- path  varchar(200)  NOT NULL
- name  varchar(200)  NOT NULL
- icon  varchar(50)  NULL
- module  varchar(50)  NULL
- parent_id  bigint  MUL NULL
- sort_order  int  NOT NULL
- required_permission  varchar(100)  NULL
- show_on_mobile  tinyint(1)  NOT NULL
- is_active  tinyint(1)  NOT NULL

## rbac_permissions
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(100)  UNI NOT NULL
- module  varchar(50)  MUL NOT NULL
- resource  varchar(50)  NOT NULL
- action  varchar(50)  NOT NULL
- description  varchar(300)  NULL

## rbac_role_permissions
- role_id  bigint  PRI NOT NULL
- permission_id  bigint  PRI NOT NULL
  FKs: permission_id->rbac_permissions.id, role_id->rbac_roles.id

## rbac_roles
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- description  varchar(300)  NULL
- is_system  tinyint(1)  NOT NULL
- is_active  tinyint(1)  NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## rbac_user_roles
- employee_id  bigint  PRI NOT NULL
- role_id  bigint  PRI NOT NULL
- assigned_by_id  bigint  NULL
- assigned_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: role_id->rbac_roles.id

## stk_audit_items
- id  bigint  PRI NOT NULL auto_increment
- audit_id  bigint  MUL NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- system_qty  decimal(16,3)  NOT NULL
- counted_qty  decimal(16,3)  NULL
- variance_qty  decimal(16,3)  NOT NULL
- variance_value  decimal(16,2)  NOT NULL
- reason  varchar(300)  NULL
- is_adjusted  tinyint(1)  NOT NULL
  FKs: audit_id->stk_audits.id

## stk_audits
- id  bigint  PRI NOT NULL auto_increment
- audit_no  varchar(50)  UNI NOT NULL
- audit_date  date  NOT NULL
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- audit_type  varchar(30)  NOT NULL
- status  varchar(30)  NOT NULL
- total_items  int  NOT NULL
- variance_items  int  NOT NULL
- variance_value  decimal(16,2)  NOT NULL
- conducted_by_id  bigint  NULL
- conducted_by_name  varchar(200)  NULL
- approved_by_id  bigint  NULL
- approved_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## stk_balance
- id  bigint  PRI NOT NULL auto_increment
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- expiry_date  date  MUL NULL
- available_qty  decimal(16,3)  NOT NULL
- reserved_qty  decimal(16,3)  NOT NULL
- transit_qty  decimal(16,3)  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- valuation_rate  decimal(16,4)  NOT NULL
- stock_value  decimal(16,2)  NOT NULL
- last_movement_at  datetime  NULL
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP
  FKs: item_id->mst_items.id, warehouse_id->whs_warehouses.id

## stk_batches
- id  bigint  PRI NOT NULL auto_increment
- batch_no  varchar(50)  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- vendor_id  bigint  NULL
- vendor_name  varchar(200)  NULL
- mfg_date  date  NULL
- expiry_date  date  MUL NULL
- received_date  date  NULL
- grn_id  bigint  NULL
- grn_no  varchar(50)  NULL
- initial_qty  decimal(16,3)  NULL
- rate  decimal(16,4)  NULL
- status  varchar(30)  MUL NOT NULL
- recall_reason  varchar(500)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: item_id->mst_items.id

## stk_ledger
- id  bigint  PRI NOT NULL auto_increment
- txn_date  datetime  MUL NOT NULL
- warehouse_id  bigint  MUL NOT NULL
- warehouse_name  varchar(200)  NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- bin_id  bigint  NOT NULL
- bin_code  varchar(50)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- direction  varchar(3)  NOT NULL
- quantity  decimal(16,3)  NOT NULL
- balance_after  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- value  decimal(16,2)  NULL
- ref_type  varchar(30)  MUL NOT NULL
- ref_id  bigint  NULL
- ref_no  varchar(50)  NULL
- remarks  varchar(500)  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## stk_reservations
- id  bigint  PRI NOT NULL auto_increment
- warehouse_id  bigint  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- batch_id  bigint  NOT NULL
- quantity  decimal(16,3)  NOT NULL
- ref_type  varchar(30)  MUL NOT NULL
- ref_id  bigint  NOT NULL
- ref_no  varchar(50)  NULL
- ref_line_id  bigint  NULL
- status  varchar(30)  MUL NOT NULL
- expires_at  datetime  NULL
- created_by_id  bigint  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## stk_transfer_items
- id  bigint  PRI NOT NULL auto_increment
- transfer_id  bigint  MUL NOT NULL
- line_no  int  NOT NULL
- item_id  bigint  MUL NOT NULL
- item_code  varchar(50)  NULL
- item_name  varchar(300)  NULL
- uom_code  varchar(20)  NULL
- batch_id  bigint  NOT NULL
- batch_no  varchar(50)  NULL
- quantity  decimal(16,3)  NOT NULL
- received_qty  decimal(16,3)  NOT NULL
- rate  decimal(16,4)  NULL
- amount  decimal(16,2)  NULL
- remarks  varchar(500)  NULL
  FKs: item_id->mst_items.id, transfer_id->stk_transfers.id

## stk_transfers
- id  bigint  PRI NOT NULL auto_increment
- transfer_no  varchar(50)  UNI NOT NULL
- transfer_date  date  NOT NULL
- from_warehouse_id  bigint  MUL NOT NULL
- from_warehouse_name  varchar(200)  NULL
- to_warehouse_id  bigint  MUL NOT NULL
- to_warehouse_name  varchar(200)  NULL
- status  varchar(30)  MUL NOT NULL
- total_items  int  NOT NULL
- total_qty  decimal(16,3)  NOT NULL
- total_value  decimal(16,2)  NOT NULL
- dispatched_at  datetime  NULL
- received_at  datetime  NULL
- remarks  text  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## sys_attachments
- id  bigint  PRI NOT NULL auto_increment
- entity_type  varchar(50)  MUL NOT NULL
- entity_id  bigint  NOT NULL
- file_name  varchar(300)  NOT NULL
- file_path  varchar(500)  NOT NULL
- file_size  bigint  NULL
- mime_type  varchar(100)  NULL
- doc_category  varchar(50)  NULL
- uploaded_by_id  bigint  NULL
- uploaded_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## sys_audit_log
- id  bigint  PRI NOT NULL auto_increment
- entity_type  varchar(50)  MUL NOT NULL
- entity_id  bigint  NOT NULL
- entity_no  varchar(50)  NULL
- action  varchar(30)  NOT NULL
- changed_fields  json  NULL
- actor_id  bigint  MUL NULL
- actor_name  varchar(200)  NULL
- ip_address  varchar(45)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## sys_doc_series
- id  bigint  PRI NOT NULL auto_increment
- doc_type  varchar(30)  MUL NOT NULL
- fiscal_year  varchar(10)  NOT NULL
- prefix  varchar(20)  NOT NULL
- pattern  varchar(50)  NOT NULL
- last_number  bigint  NOT NULL
- is_active  tinyint(1)  NOT NULL

## sys_hcm_sync_log
- id  bigint  PRI NOT NULL auto_increment
- entity  varchar(50)  MUL NOT NULL
- source  varchar(20)  NOT NULL
- started_at  datetime  NOT NULL
- finished_at  datetime  NULL
- status  varchar(20)  NOT NULL
- records_fetched  int  NULL
- records_upserted  int  NULL
- error_message  text  NULL

## sys_local_credentials
- employee_id  bigint  PRI NOT NULL
- password_hash  varchar(255)  NOT NULL
- must_change  tinyint(1)  NOT NULL
- failed_attempts  int  NOT NULL
- locked_until  datetime  NULL
- last_login_at  datetime  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## sys_notifications
- id  bigint  PRI NOT NULL auto_increment
- employee_id  bigint  MUL NOT NULL
- title  varchar(200)  NOT NULL
- body  varchar(1000)  NULL
- entity_type  varchar(50)  NULL
- entity_id  bigint  NULL
- deep_link  varchar(300)  NULL
- is_read  tinyint(1)  NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## sys_sessions
- id  bigint  PRI NOT NULL auto_increment
- employee_id  bigint  MUL NOT NULL
- token_jti  varchar(64)  UNI NOT NULL
- issued_at  datetime  NOT NULL
- expires_at  datetime  NOT NULL
- revoked_at  datetime  NULL
- ip_address  varchar(45)  NULL
- user_agent  varchar(300)  NULL

## sys_settings
- id  bigint  PRI NOT NULL auto_increment
- setting_key  varchar(100)  UNI NOT NULL
- setting_value  text  NULL
- value_type  varchar(20)  NOT NULL
- category  varchar(50)  NULL
- description  varchar(500)  NULL
- is_editable  tinyint(1)  NOT NULL
- updated_by_id  bigint  NULL
- updated_at  datetime  NOT NULL DEFAULT_GENERATED on update CURRENT_TIMESTAMP

## trn_carriers
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- vendor_id  bigint  NULL
- contact_person  varchar(200)  NULL
- phone  varchar(20)  NULL
- email  varchar(200)  NULL
- gstin  varchar(20)  NULL
- service_types  varchar(200)  NULL
- rating  decimal(4,2)  NULL
- is_active  tinyint(1)  MUL NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## trn_trip_stops
- id  bigint  PRI NOT NULL auto_increment
- trip_id  bigint  MUL NOT NULL
- stop_sequence  int  NOT NULL
- dispatch_id  bigint  MUL NULL
- dispatch_no  varchar(50)  NULL
- location_name  varchar(200)  NULL
- address  varchar(500)  NULL
- latitude  decimal(10,7)  NULL
- longitude  decimal(10,7)  NULL
- planned_arrival  datetime  NULL
- actual_arrival  datetime  NULL
- departed_at  datetime  NULL
- status  varchar(30)  NOT NULL
- pod_url  varchar(500)  NULL
- remarks  varchar(500)  NULL
  FKs: trip_id->trn_trips.id

## trn_trips
- id  bigint  PRI NOT NULL auto_increment
- trip_no  varchar(50)  UNI NOT NULL
- trip_date  date  NOT NULL
- vehicle_id  bigint  MUL NULL
- vehicle_number  varchar(50)  NULL
- carrier_id  bigint  NULL
- carrier_name  varchar(200)  NULL
- driver_name  varchar(200)  NULL
- driver_phone  varchar(20)  NULL
- route_name  varchar(200)  NULL
- status  varchar(30)  MUL NOT NULL
- total_stops  int  NOT NULL
- completed_stops  int  NOT NULL
- start_odometer  decimal(12,2)  NULL
- end_odometer  decimal(12,2)  NULL
- distance_km  decimal(12,2)  NULL
- fuel_cost  decimal(16,2)  NULL
- total_cost  decimal(16,2)  NULL
- started_at  datetime  NULL
- completed_at  datetime  NULL
- created_by_id  bigint  NULL
- created_by_name  varchar(200)  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## trn_vehicles
- id  bigint  PRI NOT NULL auto_increment
- vehicle_number  varchar(50)  UNI NOT NULL
- vehicle_type  varchar(50)  NULL
- ownership  varchar(20)  NOT NULL
- carrier_id  bigint  MUL NULL
- carrier_name  varchar(200)  NULL
- capacity_kg  decimal(16,3)  NULL
- capacity_cbm  decimal(16,3)  NULL
- is_temp_controlled  tinyint(1)  NOT NULL
- driver_name  varchar(200)  NULL
- driver_phone  varchar(20)  NULL
- warehouse_id  bigint  MUL NULL
- insurance_expiry  date  NULL
- fitness_expiry  date  NULL
- permit_expiry  date  NULL
- is_active  tinyint(1)  MUL NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## wf_actions
- id  bigint  PRI NOT NULL auto_increment
- instance_id  bigint  MUL NOT NULL
- stage_sequence  int  NOT NULL
- stage_name  varchar(200)  NULL
- actor_id  bigint  MUL NULL
- actor_name  varchar(200)  NULL
- actor_position  varchar(200)  NULL
- action  varchar(20)  NOT NULL
- comments  text  NULL
- acted_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: instance_id->wf_instances.id

## wf_delegations
- id  bigint  PRI NOT NULL auto_increment
- from_employee_id  bigint  MUL NOT NULL
- from_employee_name  varchar(200)  NULL
- to_employee_id  bigint  NOT NULL
- to_employee_name  varchar(200)  NULL
- doc_type  varchar(30)  NULL
- valid_from  date  NOT NULL
- valid_to  date  NOT NULL
- reason  varchar(300)  NULL
- is_active  tinyint(1)  NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## wf_instances
- id  bigint  PRI NOT NULL auto_increment
- doc_type  varchar(30)  MUL NOT NULL
- doc_id  bigint  NOT NULL
- doc_no  varchar(50)  NULL
- workflow_id  bigint  MUL NOT NULL
- current_sequence  int  NOT NULL
- current_stage_name  varchar(200)  NULL
- status  varchar(20)  MUL NOT NULL
- started_by_id  bigint  NULL
- started_by_name  varchar(200)  NULL
- started_at  datetime  NOT NULL DEFAULT_GENERATED
- completed_at  datetime  NULL
- due_at  datetime  NULL
  FKs: workflow_id->wf_workflows.id

## wf_pending
- id  bigint  PRI NOT NULL auto_increment
- instance_id  bigint  MUL NOT NULL
- stage_sequence  int  NOT NULL
- approver_id  bigint  MUL NOT NULL
- doc_type  varchar(30)  NOT NULL
- doc_id  bigint  NOT NULL
- doc_no  varchar(50)  NULL
- doc_summary  varchar(300)  NULL
- requested_by_name  varchar(200)  NULL
- amount  decimal(16,2)  NULL
- due_at  datetime  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
  FKs: instance_id->wf_instances.id

## wf_stage_conditions
- id  bigint  PRI NOT NULL auto_increment
- stage_id  bigint  MUL NOT NULL
- field_name  varchar(50)  NOT NULL
- operator  varchar(10)  NOT NULL
- field_value  varchar(200)  NOT NULL
- logic  varchar(5)  NOT NULL
  FKs: stage_id->wf_stages.id

## wf_stages
- id  bigint  PRI NOT NULL auto_increment
- workflow_id  bigint  MUL NOT NULL
- sequence  int  NOT NULL
- name  varchar(200)  NOT NULL
- approver_type  varchar(30)  NOT NULL
- position_id  bigint  MUL NULL
- role_id  bigint  NULL
- employee_id  bigint  NULL
- approval_mode  varchar(20)  NOT NULL
- is_optional  tinyint(1)  NOT NULL
- can_edit_document  tinyint(1)  NOT NULL
- sla_hours  int  NULL
  FKs: workflow_id->wf_workflows.id

## wf_workflows
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  MUL NOT NULL
- name  varchar(200)  NOT NULL
- doc_type  varchar(30)  MUL NOT NULL
- version  int  NOT NULL
- is_active  tinyint(1)  NOT NULL
- effective_from  date  NULL
- effective_to  date  NULL
- created_by_id  bigint  NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED

## whs_bins
- id  bigint  PRI NOT NULL auto_increment
- warehouse_id  bigint  MUL NOT NULL
- code  varchar(50)  NOT NULL
- name  varchar(200)  NULL
- parent_id  bigint  MUL NULL
- bin_type  varchar(30)  NOT NULL
- path  varchar(500)  MUL NULL
- level  int  NOT NULL
- capacity_qty  decimal(16,3)  NULL
- is_pickable  tinyint(1)  NOT NULL
- is_active  tinyint(1)  NOT NULL
  FKs: parent_id->whs_bins.id, warehouse_id->whs_warehouses.id

## whs_warehouses
- id  bigint  PRI NOT NULL auto_increment
- code  varchar(50)  UNI NOT NULL
- name  varchar(200)  NOT NULL
- facility_id  bigint  MUL NULL
- facility_name  varchar(200)  NULL
- office_id  bigint  NULL
- office_name  varchar(200)  NULL
- warehouse_type  varchar(30)  NOT NULL
- address  varchar(500)  NULL
- incharge_id  bigint  NULL
- incharge_name  varchar(200)  NULL
- is_bin_managed  tinyint(1)  NOT NULL
- is_active  tinyint(1)  MUL NOT NULL
- created_at  datetime  NOT NULL DEFAULT_GENERATED
