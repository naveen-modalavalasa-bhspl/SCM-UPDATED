# tests/bug-sheet — is each reported bug actually fixed?

The other suites ask whether the app works. This one asks a narrower, more
awkward question: **of the defects on the bug sheet, which are still there?**

One scenario per bug sheet row. Each one drives the reported steps, asserts the
behaviour the reporter said they wanted, and writes a verdict. The verdicts are
collected into their own document — `reports/BUG-STATUS.md` — separate from the
functional run report, because the person asking "is BUG-14 done" should not have
to read a run log to find out.

## Running

```powershell
npm run test:bugs            # headless
npm run test:bugs:headed     # watch it reproduce them
```

Both servers must be up (`backend` on :8000, `frontend` on :5173) and
`users.json` must have a `tester` (or `raiser`) account — the same single login
the Indent module suite uses.

Afterwards:

| File | What it holds |
| --- | --- |
| `reports/BUG-STATUS.md` | **The answer sheet.** One row per bug: FIXED / NOT FIXED, plus per-symptom detail. Always the latest run. |
| `reports/run-<ts>/BUG-STATUS.md` | The same document, kept with its run. |
| `reports/run-<ts>/bug-status.json` | The verdicts as data, for diffing two runs. |
| `reports/run-<ts>/summary.md` | The usual functional report — steps, console errors, failed API calls, a11y. |

A bug that still reproduces makes its test **fail**. That is deliberate: a
regression suite that stays green while the sheet fills up is one nobody reads.

## data/bugs.csv

The bug sheet is a private Google Sheet, so the run reads an export of it:
*File > Download > Comma-separated values*, saved as
`playwright-tests/data/bugs.csv`.

It is optional. Without it every spec still runs and still reports FIXED or NOT
FIXED — it just loses the surrounding context (module, severity, the reporter's
own steps, and what the sheet *claims* the status is). With it, the log gains the
section that is usually the most useful one: **where the sheet and the run
disagree** — tickets marked fixed that still reproduce, and open tickets that
are already fixed and can be closed.

Column names are matched loosely (`Bug ID` / `S.No` / `Ticket`, `Summary` /
`Issue` / `Description`, `Expected Result` / `Should be`, …), so an export does
not have to be reshaped by hand. A banner row above the header is skipped.

## Adding a bug

```ts
import { bugSpec, expect } from "./support/fixtures.js";

bugSpec("SCM-14", "A draft indent can be submitted twice", async ({ page, goto, bug, backend }) => {
  await goto("/indents/new", "new-indent");

  // Set up the least state that makes the defect visible — no more.
  const indent = await createIndent(page, log, { quantity: 5 });

  // One `bug.check` per symptom in the report. Phrase it as the *fixed*
  // behaviour: the log reads "PASS — the second submit is refused", which says
  // what is true now. "double submit bug" would read as a pass for the defect.
  await bug.check("Submit is disabled once the indent has left DRAFT", async () => {
    await expect(page.getByRole("button", { name: /submit for approval/i })).toBeDisabled();
  });

  await bug.check("The API refuses a second submit with 4xx, not 500", async () => {
    const response = await backend.raw("post", `/api/indents/${indent.id}/submit`);
    expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
  });

  bug.note(`Indent ${indent.indentNo} ended in status ${status}.`);
});
```

Rules that keep the log honest:

- **Checks are soft.** A bug row is usually several complaints in one sentence;
  a hard `expect` on the first one leaves the rest unknown. `bug.check` records
  and carries on, and the scenario fails once at the end with all of them. Mixed
  results give **PARTIALLY FIXED**, which is the whole reason the distinction
  exists — that is how "fixed" gets claimed too early.
- **Hard `expect` only for preconditions** the rest of the scenario cannot
  survive (a login, a created document's id). An error escaping the body is
  recorded as **BLOCKED** — never as a pass. A regression suite's commonest lie
  is failing to set up, swallowing it, and reporting green.
- **`backend.raw()` when the bug is about the server.** Reproducing through the
  browser proves the screen is wrong; asking the endpoint directly says whether
  the fix belongs in `frontend/` or `backend/`, and the log is more useful when
  it says which.
- **Clean up what you create.** These run against a real database.

## The verdicts

| Verdict | Means |
| --- | --- |
| ✅ FIXED | Every symptom asserted, none reproduced. |
| ❌ NOT FIXED | Every symptom still reproduces. |
| ⚠️ PARTIALLY FIXED | Some gone, some not — the log names which. |
| 🚧 BLOCKED | The run could not get far enough to tell. Not a pass. |
| ❔ NOT VERIFIED | A spec exists but asserted nothing. Visible on purpose, so a placeholder cannot be mistaken for coverage. |
