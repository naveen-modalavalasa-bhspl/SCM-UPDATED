# SCM ERP v1.3 — Tester Guide: RBAC & Approval Config Ladder

One page. You need at least **3 logins**: an admin, a requester, and the person who should
approve the requester's documents. Use Chrome.

## Where things are

| Screen | Path | In menu? |
|---|---|---|
| Roles & Access | `/rbac/access` | RBAC → Roles & Access |
| User Groups | `/rbac/groups` | RBAC → User Groups |
| Job Profiles | `/rbac/job-profiles` | **No — type the URL** |
| Approvals Config | `/admin/approvals-config` | Settings → Approvals Config |
| Custom Ladder | `/admin/approvals-config/custom` | **No — open from Approvals Config** |
| Fallback Log | `/admin/fallback-log` | Settings → Fallback Log |

---

## Part A — RBAC

**A1. Menu matches your role.** Log in as each test user. The left rail must show only the
modules that user's role allows. No blank screens, no menu item that 403s when clicked.

**A2. Project-wise roles.** As admin, go to Roles & Access. Give one user **different roles
on two different projects**. Log in as that user and switch project. The menu and the buttons
available must change with the project. This is the headline fix — test it hardest.

**A3. Job Profiles.** Go to `/rbac/job-profiles` (type the URL). Create a profile, add
permissions, apply it to a user. Log in as that user and confirm they got exactly those
rights — no more, no less.

**A4. The nav bug.** Log out and back in a few times. Every screen your role permits must
appear in the menu on **every** login, not just the first. This was the bug being fixed.

**A5. Backend is the real gate.** Hiding a button is not security. If you can, open a screen
your role should not have by typing its URL — you must be blocked, not shown an empty page.

---

## Part B — Approval Config Ladder

**B1. Configure a ladder.** Settings → Approvals Config. Pick a **project** and a **document
type** (start with Indent). Switch on the ranks that should approve. Save.

**B2. Route to the right approver.** As a requester **on that project**, raise an indent and
submit it. Open Approvals as the configured approver — the document must be waiting for them,
and for nobody else.

**B3. Per-project routing.** Set up a *different* ladder on a second project. Raise the same
document type from that project. It must go to that project's approver, not the first one's.
Two regions, two approvers, no crossover.

**B4. Frozen chain — important.** Submit a document so it is sitting in approval. Now go back
and **edit that ladder**. The in-flight document must keep its original approver. Only
documents submitted *after* the edit use the new ladder.

**B5. Inventory and Warehouse.** Repeat B1–B2 for **Allocation** (Inventory) and for
**Material Issue** (Warehouse). These two previously ignored the ladder and fell back to the
default chain — confirm they now follow what you configured.

**B6. No ladder configured.** Pick a project with no ladder set. Submit a document. It must
still reach *someone* and never get stuck. Then check Settings → **Fallback Log** — a fallback
entry should be recorded explaining why.

---

## Reporting a bug

Log it with: **screen name, document number, which login and which project, steps, expected vs
actual, screenshot.** For anything showing an error, also note the time — the team can pull the
full trace from App Logs.

## Do not

Do not test with someone else's login. Do not delete master data. Do not edit a ladder while
someone else is mid-test on it — B4 aside, it confuses everyone's results.
