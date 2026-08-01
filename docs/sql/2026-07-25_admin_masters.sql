-- ===========================================================================
--  SCM ERP — Admin & Masters build, 2026-07-25
--  Target: MySQL 8.0, database SCM_REBUILD
--
--  Scope is deliberately small. The DB team already ships mst_locations'
--  equivalent (whs_warehouses + whs_bins), mst_uom_conversions, mst_projects
--  and sys_audit_log, so this script does NOT recreate them — the application
--  was changed to map those tables instead.
--
--  What is left is genuinely new:
--    * user groups            (rbac_user_groups, rbac_user_group_members)
--    * the rules engine       (rule_events/rules/conditions/actions/executions)
--    * notification settings  (sys_notification_rules)
--    * document reset policy  (2 columns on sys_doc_series)
--    * the project dimension  (2 columns on stk_balance, 1 on stk_ledger)
--
--  RUN THIS BEFORE RESTARTING THE BACKEND: the app now maps
--  sys_doc_series.reset_policy and stk_balance.project_id, and a mapped column
--  the table lacks makes every SELECT on that model fail with error 1054.
--
--  Every statement is safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. User groups. Membership is derived at query time from role/position/
--    location, so those three columns are indexed and no roster is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac_user_groups (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    code        VARCHAR(50)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    description VARCHAR(300) NULL,
    parent_id   BIGINT       NULL,
    group_type  VARCHAR(20)  NOT NULL COMMENT 'ROLE|POSITION|LOCATION',
    role_id     BIGINT       NULL,
    position_id BIGINT       NULL,
    location_id BIGINT       NULL COMMENT 'whs_warehouses.id for LOCATION sub-groups',
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_rbac_user_groups_code (code),
    KEY ix_rbac_user_groups_parent_id (parent_id),
    KEY ix_rbac_user_groups_role_id (role_id),
    KEY ix_rbac_user_groups_position_id (position_id),
    KEY ix_rbac_user_groups_location_id (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rbac_user_group_members (
    group_id    BIGINT   NOT NULL,
    employee_id BIGINT   NOT NULL,
    added_by_id BIGINT   NULL,
    added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Rules engine. A business rule is rows, not a branch in code, so routing
--    changes without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule_events (
    code           VARCHAR(50)  NOT NULL,
    name           VARCHAR(200) NOT NULL,
    module         VARCHAR(50)  NULL,
    description    VARCHAR(300) NULL,
    context_schema JSON         NULL COMMENT 'fields this event supplies, for the GUI',
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rule_rules (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    event_code     VARCHAR(50)  NOT NULL,
    name           VARCHAR(200) NOT NULL,
    description    VARCHAR(300) NULL,
    priority       INT          NOT NULL DEFAULT 100 COMMENT 'lower runs first',
    stop_on_match  TINYINT(1)   NOT NULL DEFAULT 0,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    effective_from DATE         NULL,
    effective_to   DATE         NULL,
    created_by_id  BIGINT       NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_rule_rules_event_active (event_code, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rule_conditions (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    rule_id     BIGINT       NOT NULL,
    field_name  VARCHAR(50)  NOT NULL,
    operator    VARCHAR(10)  NOT NULL COMMENT 'EQ|NEQ|GT|GTE|LT|LTE|IN|NOT_IN|BETWEEN',
    field_value VARCHAR(200) NOT NULL,
    logic       VARCHAR(5)   NOT NULL DEFAULT 'AND',
    PRIMARY KEY (id),
    KEY ix_rule_conditions_rule_id (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rule_actions (
    id          BIGINT      NOT NULL AUTO_INCREMENT,
    rule_id     BIGINT      NOT NULL,
    seq         INT         NOT NULL DEFAULT 1,
    action_type VARCHAR(30) NOT NULL
        COMMENT 'ROUTE_APPROVAL|ROUTE_FULFILLMENT|SPLIT_FULFILLMENT|NOTIFY|SET_FIELD',
    params      JSON        NULL,
    PRIMARY KEY (id),
    KEY ix_rule_actions_rule_id (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Written on every evaluation, matched or not: "no rule covered this" is the
-- case people actually need to debug.
CREATE TABLE IF NOT EXISTS rule_executions (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    event_code VARCHAR(50) NOT NULL,
    rule_id    BIGINT      NULL,
    doc_type   VARCHAR(30) NULL,
    doc_id     BIGINT      NULL,
    matched    TINYINT(1)  NOT NULL DEFAULT 0,
    context    JSON        NULL,
    actions    JSON        NULL,
    error      TEXT        NULL,
    acted_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_rule_executions_event_code (event_code),
    KEY ix_rule_executions_rule_id (rule_id),
    KEY ix_rule_executions_doc_id (doc_id),
    KEY ix_rule_executions_acted_at (acted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Notification settings. Distinct from sys_notifications, which is the
--    delivered-message inbox; this table decides who gets one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_notification_rules (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    event_code     VARCHAR(50)  NOT NULL,
    stage          VARCHAR(100) NULL COMMENT 'NULL means every stage',
    recipient_type VARCHAR(20)  NOT NULL COMMENT 'ROLE|POSITION|GROUP|EMPLOYEE',
    recipient_id   BIGINT       NULL,
    recipient_name VARCHAR(200) NULL,
    channel        VARCHAR(20)  NOT NULL DEFAULT 'IN_APP',
    template       TEXT         NULL,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_sys_notification_rules_event_code (event_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
--  ALTERs. MySQL has no "ADD COLUMN IF NOT EXISTS", so each is guarded.
-- ===========================================================================
DELIMITER //
DROP PROCEDURE IF EXISTS scm_add_column //
CREATE PROCEDURE scm_add_column(IN tbl VARCHAR(64), IN col VARCHAR(64),
                                IN ddl VARCHAR(255))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE()
                     AND TABLE_NAME = tbl AND COLUMN_NAME = col) THEN
        SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
        PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
    END IF;
END //

DROP PROCEDURE IF EXISTS scm_add_index //
CREATE PROCEDURE scm_add_index(IN tbl VARCHAR(64), IN idx VARCHAR(64),
                               IN cols VARCHAR(255), IN uniq TINYINT)
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = DATABASE()
                     AND TABLE_NAME = tbl AND INDEX_NAME = idx) THEN
        SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD ',
                        IF(uniq = 1, 'UNIQUE ', ''), 'INDEX `', idx, '` (', cols, ')');
        PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
    END IF;
END //
DELIMITER ;

-- 4. Document numbering: reset policy -------------------------------------
-- NULL already reads as NEVER in code; the UPDATE just makes the admin screen
-- show an explicit value instead of a blank.
CALL scm_add_column('sys_doc_series', 'reset_policy',
                    "reset_policy VARCHAR(10) NULL COMMENT 'NEVER|YEARLY|MONTHLY'");
CALL scm_add_column('sys_doc_series', 'last_reset_period',
                    "last_reset_period VARCHAR(10) NULL COMMENT '2026-27 or 2026-07'");
UPDATE sys_doc_series SET reset_policy = 'NEVER' WHERE reset_policy IS NULL;

-- 5. Stock ledger: the project dimension -----------------------------------
-- 0 rather than NULL means "no project", matching the convention the DB team
-- already uses for bin_id and batch_id: MySQL lets NULLs repeat inside a
-- unique index, which would silently allow duplicate balance rows.
CALL scm_add_column('stk_balance', 'project_id',
                    "project_id BIGINT NOT NULL DEFAULT 0 COMMENT '0 = no project'");
CALL scm_add_column('stk_balance', 'project_name', 'project_name VARCHAR(200) NULL');
CALL scm_add_column('stk_ledger', 'project_id',
                    "project_id BIGINT NOT NULL DEFAULT 0 COMMENT '0 = no project'");

CALL scm_add_index('stk_balance', 'ix_stk_balance_project_id', 'project_id', 0);
CALL scm_add_index('stk_ledger', 'ix_stk_ledger_project_id', 'project_id', 0);

-- The balance key. Without this, two rows could hold a balance for the same
-- item in the same place and move_stock()'s locking upsert would not be safe.
CALL scm_add_index('stk_balance', 'uq_stk_balance_item_wh_bin_batch_proj',
                   'item_id, warehouse_id, bin_id, batch_id, project_id', 1);

DROP PROCEDURE IF EXISTS scm_add_column;
DROP PROCEDURE IF EXISTS scm_add_index;

-- ===========================================================================
--  6. Seed the rules-engine event catalogue. Without these rows the admin GUI
--     has no vocabulary to build rules from, and create_rule rejects the event.
-- ===========================================================================
INSERT INTO rule_events (code, name, module, description, context_schema, is_active)
VALUES
 ('INDENT_SUBMITTED', 'Indent submitted', 'indents',
  'A requester submitted an indent for approval and fulfillment routing',
  '{"indent_id":"number","indent_no":"string","category_code":"string",
    "item_id":"number","quantity":"number","estimated_value":"number",
    "requester_id":"number","requester_position_id":"number",
    "department_id":"number","warehouse_id":"number","project_id":"number",
    "priority":"string"}', 1),
 ('INDENT_APPROVED', 'Indent approved', 'indents',
  'Every approval stage on an indent completed',
  '{"indent_id":"number","indent_no":"string","quantity":"number",
    "estimated_value":"number","warehouse_id":"number","project_id":"number"}', 1),
 ('PO_SUBMITTED', 'Purchase order submitted', 'procurement',
  'A purchase order was submitted for approval',
  '{"po_id":"number","po_no":"string","vendor_id":"number",
    "total_amount":"number","buyer_id":"number","department_id":"number"}', 1),
 ('GRN_RECEIVED', 'Goods received', 'logistics',
  'A receipt was booked against a purchase order',
  '{"grn_id":"number","po_id":"number","warehouse_id":"number",
    "item_id":"number","accepted_quantity":"number"}', 1),
 ('STOCK_BELOW_THRESHOLD', 'Stock below threshold', 'logistics',
  'An item balance fell under its reorder level',
  '{"item_id":"number","item_code":"string","warehouse_id":"number",
    "project_id":"number","available_qty":"number","reorder_level":"number"}', 1)
AS new
ON DUPLICATE KEY UPDATE
    name = new.name, module = new.module, description = new.description,
    context_schema = new.context_schema, is_active = new.is_active;

-- ===========================================================================
--  Verify
-- ===========================================================================
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('rbac_user_groups','rbac_user_group_members','rule_events',
                      'rule_rules','rule_conditions','rule_actions',
                      'rule_executions','sys_notification_rules');

SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'stk_balance' AND COLUMN_NAME IN ('project_id','project_name'))
     OR (TABLE_NAME = 'stk_ledger'  AND COLUMN_NAME = 'project_id')
     OR (TABLE_NAME = 'sys_doc_series'
         AND COLUMN_NAME IN ('reset_policy','last_reset_period')));
