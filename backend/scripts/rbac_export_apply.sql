-- ===========================================================================
--  RBAC export / apply  —  roles + their pages + their actions
--
--  Ids are NOT portable between databases (rbac_roles.id, rbac_permissions.id
--  differ per DB). Everything below matches on CODE.
--
--  Run sections 1-3 on the SOURCE db (read-only).
--  Run sections 4-6 on the TARGET db.
-- ===========================================================================

SET SESSION group_concat_max_len = 1000000;   -- default 1024 truncates silently


-- ---------------------------------------------------------------------------
-- 1. REPORT: one row per role — pages it can see, actions it can do
-- ---------------------------------------------------------------------------
SELECT
    r.code                                             AS role_code,
    r.name                                             AS role_name,
    CASE
        WHEN r.description LIKE 'PROFILE:%'  THEN 'JOB PROFILE'
        WHEN r.description LIKE 'HCM role%'  THEN 'HCM ROLE'
        ELSE 'PLAIN ROLE'
    END                                                AS role_kind,
    -- job profile only: "PROFILE:<project_id>:<JOB>|SCOPE:<rung>"
    SUBSTRING_INDEX(SUBSTRING_INDEX(r.description, 'PROFILE:', -1), '|', 1)
        AS profile_key,
    SUBSTRING_INDEX(r.description, 'SCOPE:', -1)       AS data_scope,
    r.is_active,
    COUNT(DISTINCT CASE WHEN p.resource  = 'page' THEN p.id END) AS page_count,
    COUNT(DISTINCT CASE WHEN p.resource <> 'page' THEN p.id END) AS action_count,
    GROUP_CONCAT(DISTINCT CASE WHEN p.resource = 'page'
        THEN pg.name END ORDER BY pg.name SEPARATOR ', ')        AS pages,
    GROUP_CONCAT(DISTINCT CASE WHEN p.resource <> 'page'
        THEN p.code END ORDER BY p.code SEPARATOR ', ')          AS actions
FROM rbac_roles r
LEFT JOIN rbac_role_permissions rp ON rp.role_id = r.id
LEFT JOIN rbac_permissions      p  ON p.id = rp.permission_id
LEFT JOIN rbac_pages            pg ON pg.code = SUBSTRING(
        p.code, 6, CHAR_LENGTH(p.code) - 10)   -- 'page.' + code + '.view'
    AND p.resource = 'page'
GROUP BY r.id, r.code, r.name, r.description, r.is_active
ORDER BY role_kind, r.code;


-- ---------------------------------------------------------------------------
-- 1b. EFFECTIVE pages (what the left rail actually shows)
--     A page is ON when the role holds its own `page.<code>.view`; a page that
--     has no such permission falls back to required_permission. Same rule as
--     rbac.service.get_user_menu / profiles._page_gate.
-- ---------------------------------------------------------------------------
SELECT r.code AS role_code, pg.code AS page_code, pg.name AS page_name,
       pg.module, pg.path
FROM rbac_roles r
JOIN rbac_pages pg ON pg.is_active = 1
WHERE r.is_active = 1
  AND (
        EXISTS (SELECT 1 FROM rbac_role_permissions rp
                JOIN rbac_permissions p ON p.id = rp.permission_id
                WHERE rp.role_id = r.id
                  AND p.code = CONCAT('page.', pg.code, '.view'))
     OR (
        NOT EXISTS (SELECT 1 FROM rbac_permissions p
                    WHERE p.code = CONCAT('page.', pg.code, '.view'))
        AND (pg.required_permission IS NULL
             OR EXISTS (SELECT 1 FROM rbac_role_permissions rp
                        JOIN rbac_permissions p ON p.id = rp.permission_id
                        WHERE rp.role_id = r.id
                          AND p.code = pg.required_permission))
       )
  )
ORDER BY r.code, pg.module, pg.sort_order;


-- ---------------------------------------------------------------------------
-- 2. EXPORT: the portable pair list (this is what gets carried across)
-- ---------------------------------------------------------------------------
SELECT r.code AS role_code, r.name AS role_name, r.description AS role_description,
       r.is_system, r.is_active, p.code AS permission_code
FROM rbac_roles r
JOIN rbac_role_permissions rp ON rp.role_id = r.id
JOIN rbac_permissions      p  ON p.id = rp.permission_id
ORDER BY r.code, p.code;


-- ---------------------------------------------------------------------------
-- 3. Same export, emitted as ready-to-paste INSERT statements for the staging
--    table in section 4. Copy the single output column into a .sql file.
-- ---------------------------------------------------------------------------
SELECT CONCAT(
    'INSERT IGNORE INTO rbac_import VALUES (',
    QUOTE(r.code), ',', QUOTE(r.name), ',',
    IFNULL(QUOTE(r.description), 'NULL'), ',',
    r.is_system, ',', r.is_active, ',', QUOTE(p.code), ');'
) AS stmt
FROM rbac_roles r
JOIN rbac_role_permissions rp ON rp.role_id = r.id
JOIN rbac_permissions      p  ON p.id = rp.permission_id
ORDER BY r.code, p.code;


-- ===========================================================================
--  TARGET DATABASE FROM HERE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 4. Staging table, then load section 3's output (or the CSV from section 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac_import (
    role_code        VARCHAR(50)  NOT NULL,
    role_name        VARCHAR(200) NOT NULL,
    role_description VARCHAR(300) NULL,
    is_system        TINYINT(1)   NOT NULL DEFAULT 0,
    is_active        TINYINT(1)   NOT NULL DEFAULT 1,
    permission_code  VARCHAR(100) NOT NULL,
    PRIMARY KEY (role_code, permission_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- TRUNCATE TABLE rbac_import;    -- before a re-run


-- ---------------------------------------------------------------------------
-- 5. PRE-FLIGHT — run these two BEFORE section 6. Both must return 0 rows.
--    A missing permission code is a grant that would vanish silently.
-- ---------------------------------------------------------------------------
SELECT DISTINCT i.permission_code AS missing_permission_on_target
FROM rbac_import i
LEFT JOIN rbac_permissions p ON p.code = i.permission_code
WHERE p.id IS NULL;

-- Pages the source grants that this DB does not have (menu rows won't appear)
SELECT DISTINCT SUBSTRING(i.permission_code, 6,
                          CHAR_LENGTH(i.permission_code) - 10) AS missing_page
FROM rbac_import i
LEFT JOIN rbac_pages pg
       ON pg.code = SUBSTRING(i.permission_code, 6,
                              CHAR_LENGTH(i.permission_code) - 10)
WHERE i.permission_code LIKE 'page.%.view' AND pg.id IS NULL;


-- ---------------------------------------------------------------------------
-- 6. APPLY — idempotent, mirrors the source exactly for the imported roles.
--    Roles NOT in the import file are left completely alone.
-- ---------------------------------------------------------------------------
START TRANSACTION;

-- 6a. create roles that don't exist yet
INSERT INTO rbac_roles (code, name, description, is_system, is_active, created_at)
SELECT DISTINCT i.role_code, i.role_name, i.role_description,
       i.is_system, i.is_active, NOW()
FROM rbac_import i
LEFT JOIN rbac_roles r ON r.code = i.role_code
WHERE r.id IS NULL;

-- 6b. refresh name/description/active on roles that already existed
--     (description carries the job-profile key and the data scope rung)
UPDATE rbac_roles r
JOIN (SELECT DISTINCT role_code, role_name, role_description, is_system, is_active
      FROM rbac_import) i ON i.role_code = r.code
SET r.name        = i.role_name,
    r.description = i.role_description,
    r.is_system   = i.is_system,
    r.is_active   = i.is_active;

-- 6c. revoke what the source no longer grants (only for imported roles)
DELETE rp FROM rbac_role_permissions rp
JOIN rbac_roles       r ON r.id = rp.role_id
JOIN rbac_permissions p ON p.id = rp.permission_id
WHERE r.code IN (SELECT DISTINCT role_code FROM rbac_import)
  AND NOT EXISTS (SELECT 1 FROM rbac_import i
                  WHERE i.role_code = r.code AND i.permission_code = p.code);

-- 6d. grant what's new
INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_import i
JOIN rbac_roles       r ON r.code = i.role_code
JOIN rbac_permissions p ON p.code = i.permission_code;

COMMIT;


-- ---------------------------------------------------------------------------
-- 7. VERIFY — run section 1 on both databases and diff, or run this on target:
--     every row here is a mismatch; empty result = identical.
-- ---------------------------------------------------------------------------
SELECT i.role_code, i.permission_code, 'missing on target' AS problem
FROM rbac_import i
LEFT JOIN rbac_roles       r  ON r.code = i.role_code
LEFT JOIN rbac_permissions p  ON p.code = i.permission_code
LEFT JOIN rbac_role_permissions rp
       ON rp.role_id = r.id AND rp.permission_id = p.id
WHERE rp.role_id IS NULL
UNION ALL
SELECT r.code, p.code, 'extra on target'
FROM rbac_role_permissions rp
JOIN rbac_roles       r ON r.id = rp.role_id
JOIN rbac_permissions p ON p.id = rp.permission_id
WHERE r.code IN (SELECT DISTINCT role_code FROM rbac_import)
  AND NOT EXISTS (SELECT 1 FROM rbac_import i
                  WHERE i.role_code = r.code AND i.permission_code = p.code);

-- DROP TABLE rbac_import;   -- when done
