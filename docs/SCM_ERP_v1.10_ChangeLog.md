# SCM ERP v1.10 — Change Log

**Released:** 2026-08-26 · **Branch:** `qa` · **Migration head:** `e8f9a0b1c2d3`

Three defects reported against the live app (`103.174.161.68:8022`). All three were
invisible from the screens — each failed silently and looked like nothing was wrong.

---

## 1. New employees could not sign in with the default password

**Symptom.** Every HCM joiner had to be given access by hand in RBAC, receive a
generated password from an admin, then change it. `Bavya@123` never worked for them.

**Cause.** `compose.yaml` passed the backend a fixed list of 8 environment variables,
and `backend/.env` is excluded from the image by `.dockerignore`. So
`NEW_USER_DEFAULT_PASSWORD` did not exist inside the container at all.
`hcm/sync._issue_missing_logins` reads it, finds nothing, and returns `0` — with no
log line and no panel on the sync screen — so every sync reported all-green while
issuing no logins. 7 of 1,933 active employees were left with no credential row; the
"Invalid credentials" they saw meant *no account*, not *wrong password*.

**Fix.** The missing settings are now declared in `compose.yaml` and documented in
`.env.deploy.example`.

## 2. Job Profiles listed a "Manager" job that no longer exists

**Symptom.** RBAC > Job Profiles offered `SUPPLY CHAIN MANAGEMENT · Manager` on the
deployed app. The same sync on a local database did not produce it.

**Cause.** HCM deleted position 2144 (`WM@SCM`, role MANAGER). Retirement skipped it:
`hcm/sync._stale_position_ids` exempted any position that had entered the mirror
through the *employee* feed, on the grounds that the positions feed never lists those.
The exemption was unconditional, so such a row could never be retired — even after HCM
dropped it from the employee record too. Which database it bit was pure history.

**Fix.** The exemption now lasts only while an employee record still names the post,
compared via `synced_at` against the last successful employees sync. Dead posts retire
on the next sync; a rescued post still in use is untouched. Verified against the live
mirror: retires nothing that was not already retired.

## 3. "Forgot password" never delivered a mail

**Symptom.** Users entered their address, saw "check your inbox", and nothing arrived.
Reproduced on both the deployed app and a local one.

**Cause.** Two independent blockers.
- The reset flow finds an account by `hcm_employees.email`, and **the rebuilt HCM
  serves no employee email at all** — the only address in its payload is
  `position.reporting_to[0].employee_email`, which belongs to the person's *manager*.
  All 1,933 mirrored employees held `NULL`, so every request matched nobody.
- No `MAIL_*` settings reached the deployed container (same cause as defect 1), so
  `mail_configured` was false and nothing could send regardless.

The endpoint answers `204` unconditionally by design — so it cannot be used to test
which accounts exist — which is why neither blocker was visible from the screen.

**Fix.** Forgot-password now takes an **employee code and an email**. If the address
is already on the account the link goes out immediately. If it is not, the address is
filed in `sys_email_claims` and **an administrator confirms it belongs to that person**
before any mail is sent; approving records the address and sends the link in one press,
and every later reset for that person is immediate. The queue is **Settings > Mail >
Reset requests**, gated on `admin.users.manage`.

The confirmation step is not optional friction: employee codes appear on every user
list, approval and document, so trusting a typed address would let anyone have another
person's reset link delivered to their own inbox.

`PASSWORD_RESET_EMAIL_DOMAIN` restricts delivery to one domain (e.g. `bhspl.in`);
an address outside it is refused before a claim is filed.

---

## Deploying

The backend container runs `alembic upgrade head` on start, so the new table is
created automatically. **Before bringing it up**, add these to the `.env` file next to
`compose.yaml` (see `.env.deploy.example`; secrets come from the password manager, not
from this document). Without them, defects 1 and 3 are not actually fixed.

```
NEW_USER_DEFAULT_PASSWORD=
MAIL_SMTP_HOST=          MAIL_SMTP_PORT=587      MAIL_USERNAME=
MAIL_PASSWORD=           MAIL_FROM=              MAIL_FROM_NAME=SCM ERP
MAIL_STARTTLS=true       MAIL_SMTP_SSL=false
MAIL_IMAP_HOST=          MAIL_IMAP_PORT=993      MAIL_IMAP_SSL=true
APP_BASE_URL=            PASSWORD_RESET_MINUTES=30
PASSWORD_RESET_EMAIL_DOMAIN=
```

`APP_BASE_URL` must be the **public app URL**, not localhost — it is what the reset
link in the email points at.

## Verifying after deploy

| Check | Expected |
|---|---|
| Settings > Mail | "Sending as …" shows the company address |
| `GET /api/mail/status` | `can_send: true` |
| Run an HCM sync, then RBAC > Users | employees with no access falls to 0 |
| RBAC > Job Profiles | no `Manager` under SUPPLY CHAIN MANAGEMENT |
| Forgot password → confirm in queue | link arrives and opens the reset page |

## Files changed

`compose.yaml` · `.env.deploy.example` · `app/core/config.py` ·
`app/shared/enums.py` · `app/platform/settings/models.py` ·
`app/platform/hcm/sync.py` · `app/platform/mail/{service,router,schemas}.py` ·
`alembic/versions/e8f9a0b1c2d3_email_claims_for_password_reset.py` ·
`frontend/src/pages/PasswordResetPages.tsx` ·
`frontend/src/modules/admin/pages/MailPage.tsx`

## Known limitations

- A post HCM deletes today retires on the **second** sync after the deletion, not the
  first: retirement runs during the positions entity, which syncs before employees, so
  it reads the previous employees run. Deliberate — a stale row costs a line on a
  screen, retiring a live one costs somebody their access.
- Existing employees still have no email on file, so the first reset for each person
  goes through the confirmation queue. This is one approval per person, once.
