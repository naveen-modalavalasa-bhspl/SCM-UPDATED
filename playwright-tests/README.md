# playwright-tests

Browser-driven functional tests for the SCM ERP web app, sitting alongside
`backend/` and `frontend/`. It clicks the real UI in a real browser and, while it
does, records every non-functional complaint the browser makes — so a run answers
both *"does the flow work"* and *"was anything broken on the way"* without waiting
for a manual tester to notice.

## What it logs

Each run writes `reports/run-<timestamp>/`:

| File | What it holds |
| --- | --- |
| `summary.md` | The report to read. Pass/fail, every step, every finding. |
| `events.jsonl` | One JSON object per event — greppable, diffable between runs. |
| `screens/` | Numbered full-page screenshot of every step, in order. |
| `html/` | Playwright's own report (`npm run report`). |
| `artifacts/` | Trace + video, kept for failures. |

Findings captured automatically on every screen visited:

- **Functional** — each step's outcome, the assertions, the approval history.
- **JavaScript errors** — uncaught exceptions with stack traces.
- **Console errors and warnings** — Vite/React Router noise filtered out.
- **Failed API calls** — any 4xx/5xx, with the response body.
- **Performance** — API calls over `SLOW_REQUEST_MS`, screens over `SLOW_PAGE_MS`.
- **Accessibility** — axe-core WCAG 2 A/AA violations per screen.

## Setup

```powershell
cd playwright-tests
npm install
npm run install:browsers

copy .env.example .env          # BASE_URL / API_URL / thresholds
copy users.example.json users.json   # real logins — gitignored, never committed
```

Both servers must already be running (`backend` on :8000, `frontend` on :5173).

### users.json

`raiser` creates the indent. `approvers` is a **pool, not an order** — at each rung
the run asks `/api/workflow/pending` which of these accounts actually holds the
document, then drives that person's inbox. Re-configuring the approval ladder in
*Settings > Approvals Config* therefore needs no change to any test; just make sure
every possible approver has an entry here.

If the run stops with *"none of the configured approver accounts has it in their
queue"*, the message names the person the backend is waiting on — add them.

## Running

```powershell
npm test                 # headless, writes the report
npm run test:headed      # watch it click (set SLOW_MO=400 in .env to follow along)
npm run test:debug       # step through with the inspector
npm run report           # open the HTML report
npm run codegen          # record selectors for a new test
```

## Adding a flow

1. Put shared clicking in `src/pages/<screen>.ts` — one exported function per
   action, each wrapped in `log.runStep()` so it shows up in the report.
2. Put the journey in `tests/<flow>.spec.ts`, using the `test` from
   `src/fixtures.js` (not `@playwright/test`) — that is what wires the logging.
3. Use `goto()` rather than `page.goto()`: it waits for the app to settle, times
   the load, screenshots and accessibility-scans the screen.
4. Assertion messages are read by people who did not write the test. Say what
   should have happened, not `expected true`.
