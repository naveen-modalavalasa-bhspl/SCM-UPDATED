# Load test — 2026-09-03

Measured, not estimated. Everything below came out of Locust runs against the real
application on a real copy of the working database.

## Rig

| | |
|---|---|
| Host | one 16-core Windows laptop, load generator **and** server on the same box |
| Database | `SCM_LOADTEST` — a server-side clone of `SCM_PROD` (142 tables, 348k rows, 239 MB) |
| Users | 1,200 real employees from the HCM mirror, each with their own position, dealt 8 job-profile roles round-robin |
| Profile | 90% office work (indent register, dashboard, approvals inbox, activity ledger, notifications), 10% repeated sign-in |
| Think time | 1–5 s between actions |
| Duration | 90 s per level, spawn 25/s |

`SCM_PROD` was never written to. The clone, the credential minting and the item seeding
are `backend/scripts/clone_for_loadtest.py`, `seed_loadtest_users.py` and
`seed_loadtest_items.py`, each of which refuses to run against a database whose name
does not contain "loadtest".

**BEFORE** = the shape the app shipped in: one process, `pool_size=5, max_overflow=5`,
permission cache off.
**AFTER** = the shape it ships in now: 9 worker processes, `pool 20+10`, permission
cache on, MySQL `max_connections` raised to 500.

## Result

| config | users | req/s | median | p95 | requests | failures |
|---|---:|---:|---:|---:|---:|---:|
| BEFORE | 50 | 18.2 | 55 ms | 480 ms | 1,634 | 1 |
| BEFORE | 200 | 55.5 | **720 ms** | 2,000 ms | 4,961 | 7 |
| BEFORE | 500 | 54.4 | **5,800 ms** | 13,000 ms | 4,874 | 1 |
| BEFORE | 1000 | 51.1 | **12,000 ms** | 28,000 ms | 4,577 | 39 |
| AFTER | 50 | 18.2 | 42 ms | 360 ms | 1,616 | 2 |
| AFTER | 200 | 71.2 | **42 ms** | 370 ms | 6,387 | 16 |
| AFTER | 500 | 158.4 | **54 ms** | 980 ms | 14,244 | 21 |
| AFTER | 1000 | 183.3 | **1,300 ms** | 4,800 ms | 16,442 | 16 |

Read the throughput column first. BEFORE flattens at **~55 req/s** from 200 users
onwards: every user added past that point buys queue time, not work. The median goes
55 ms → 720 ms → 5.8 s → 12 s while the server does the same amount per second
throughout. That is the single-process ceiling, and it is what "one uvicorn worker"
means in practice.

AFTER reaches **183 req/s** and holds a 54 ms median at 500 users. It is comfortable
to about 500 and degrades — without failing — at 1,000.

**~3.4× the throughput, ~10× the usable concurrency, at 500 users a 107× better
median.** At 50 users the two are identical, correctly: nobody is queuing there, so the
server is not the constraint in either build.

The failures in the AFTER column are almost all `403` on
`/api/indents/acknowledgments` — an artifact of dealing roles round-robin, so some test
users genuinely lack `indent.acknowledge`. Not a defect.

## The pool blocker, reproduced

BEFORE at 1,000 users, in the server log:

```
sqlalchemy.exc.TimeoutError: QueuePool limit of size 5 overflow 5 reached,
connection timed out, timeout 30.00
```

196 occurrences, surfacing to users as `500`s on login, `/api/auth/me`,
`/api/indents` and the dashboard. AFTER: zero. This is B-02 from the load rating,
observed rather than predicted.

## The login throttle, reproduced by accident

The first run came back with 98% of logins failing. That was the new per-address rate
limit doing exactly its job — all load originates from 127.0.0.1, so 1,000 virtual
users look like one very determined attacker. The ladder above was run with
`LOGIN_RATE_PER_MINUTE` raised, or it would have measured the limiter.

Worth stating plainly, because it cuts both ways: the throttle works, and it is a
per-address control, so users behind one office NAT share a bucket. If a site has more
than 30 people signing in per minute through a single public IP, raise
`LOGIN_RATE_PER_MINUTE` for that deployment.

## The dashboard cliff — the top parked item, now quantified

`inventory.get_stock_replenishment` issues one `SUM(available_qty)` query **per item**
that is active and has a reorder level, with no pagination and no limit.
`home.summary` calls it on every dashboard load, which is every sign-in.

`/api/home/summary`, single user, no other load:

| catalogue | items with a reorder level | latency |
|---|---:|---:|
| 87 items (today) | **0** | 86 ms |
| 87 items | 87 | 221 ms |
| 5,046 items | 5,046 | **4,930 ms** |

Roughly 1 ms per item, linear, on the first screen every user sees.

Then the same fat catalogue under only 200 concurrent users:

| | median | p95 | timeouts |
|---|---:|---:|---:|
| `/api/home/summary` | **55,000 ms** | 60,000 ms | 29% |
| `/api/indents` (list) | 720 ms | 3,900 ms | 0 |

The dashboard stops answering, and it drags the rest of the application with it — the
indent register went from a 42 ms median to 720 ms because the dashboard's queries are
holding the pool.

**The dangerous part is the trigger.** Not one of the 87 live items has a reorder level
set today, so the loop currently runs zero times and the dashboard answers in 86 ms.
The defect is dormant, not absent — and what wakes it is an administrator filling in
reorder levels on the item master. That is an ordinary data-entry action, done from a
form, by someone with no reason to think it is a performance decision. There is no
deploy, no code change and no warning.

This is parked item #1 in `docs/09_CAPACITY_BACKLOG.md`. It should not stay parked.

## What this does NOT prove

- **Writes were not exercised.** The profile is reads plus authentication. Raising an
  indent, approving one, moving stock and posting a GRN all take row locks that this
  test never touched, and contention on those is a different question.
- **Load generator and server shared one 16-core box** and competed for CPU. A real
  deployment separates them, so the AFTER numbers are pessimistic — by how much is
  unknown.
- **Redis was not running** (no Docker on this host), so the permission cache ran in
  its per-process fallback: nine copies rather than one shared one. It worked, and the
  shared path is unmeasured.
- **One API container, nine workers.** Production compose runs two replicas of that,
  so it should do better again — unmeasured.
- **gunicorn is POSIX-only**, so the local runs used `uvicorn --workers 9` to get the
  same multi-process shape. The container's actual gunicorn config is untested here.
- **The data is small in the dimensions that matter**: 131 indents, 87 items, 30
  approvals. The registers are cheap to page through because there is nothing in them.
  Re-run this against a year of documents before trusting the list-screen numbers.

## Verdict

**Can 1,000 people use it at once? On this evidence — yes for ordinary list-and-form
work, with a caveat and a condition.**

- Up to ~500 concurrent it is comfortable: 54 ms median, sub-second p95, no errors.
- At 1,000 concurrent it is usable but slow: 1.3 s median, 4.8 s p95, no failures — and
  that is from a single container sharing a laptop with the load generator. Two
  replicas on a real host should absorb it.
- **The condition:** do not set reorder levels on a large item master until the
  dashboard loop is fixed. That one data change takes the system from 42 ms to
  unusable at a fifth of the target load, and nothing in the product warns anybody.

## Re-running it

```
# from the repo root, with backend/.env pointing at the clone
backend/.venv/Scripts/python -m scripts.clone_for_loadtest SCM_LOADTEST
backend/.venv/Scripts/python -m scripts.seed_loadtest_users loadtest/users.txt
DURATION=90s sh loadtest/run_ladder.sh after http://127.0.0.1:8901 "50 200 500 1000"
```

`loadtest/users.txt` is gitignored — it is a list of accounts that all share one
password. Drop the clone when finished: `DROP DATABASE SCM_LOADTEST;`


---

# Write / transaction test — 2026-09-03

The read test says the server can serve screens. This one asks the question that
matters for a system holding stock and approvals: does a thousand people pressing
buttons at once leave the books correct?

Same rig, same clone, same 1,935-employee pool — but the profile is a **pipeline**
(`loadtest/locustfile_write.py`), not a script. Each persona works whatever queue its
own RBAC grants give it, and the queues are fed by the personas upstream: requesters
keep raising indents, approvers keep approving whatever is parked on them. A scripted
end-to-end journey would spend the whole run waiting for stage one.

Per-second telemetry is in `loadtest/telemetry.py` and writes one CSV row per second
of the run (`timeline.csv` in each result folder): sessions, distinct roles active,
indents raised, approvals split by ladder rung, allocations, issues, QC, dispatches,
acknowledgements, read/write mix and every error class.

## Throughput

| users | req/s | median | p95 | writes | writes/s | indents raised | approvals | 5xx |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 79.1 | 72 ms | 1,300 ms | 2,467 | 21.1 | 1,058 | 49 | 0 |
| 500 | 120.4 | 150 ms | 13,000 ms | 3,551 | 30.1 | 1,420 | 40 | 1 |
| 1000 | 116.6 | **2,300 ms** | 23,000 ms | 3,442 | 29.2 | 1,157 | 63 | 0 |

Writes saturate at **~30 per second** around 500 concurrent users. Past that the
median goes to 2.3 s and the p95 to 23 s while throughput stops rising — the same
shape the read test showed, one level earlier, which is expected: a write holds a
connection for a transaction rather than a query.

**200 concurrent users writing is comfortable** (72 ms median). 500 is the knee. At
1,000 it still completes everything, but a two-second median on a save button is not
a working system.

## Integrity — the part that actually matters

`backend/scripts/loadtest_integrity.py`, run before and after. The load wrote:

```
ind_indents        +4,175       wf_instances   +3,640
ind_indent_items   +8,303       wf_actions     +3,814
sys_audit_log      +7,838
```

After 4,175 documents were numbered concurrently by up to 1,000 users:

| check | result |
|---|---|
| Duplicate document numbers (`indent_no`, `po_no`, `tr_no`, …) | **none** |
| `stk_balance` vs `stk_ledger` reconciliation | **clean** |
| Negative `available_qty` / `reserved_qty` | **none** |
| `reserved_qty` exceeding `total_qty` | **none** |
| Decided workflow instances with no `wf_actions` row | **none** |
| InnoDB deadlocks | **1** (from 0) |
| InnoDB lock timeouts | 0 new |

**The numbering row lock holds.** `shared/numbering.py` takes `SELECT ... FOR UPDATE`
on `sys_doc_series`, and 4,175 concurrent numberings produced zero duplicates. That
was the single most likely thing to break, and it did not.

**One deadlock in the whole run.** InnoDB resolves a deadlock by killing one
transaction, so somewhere one user saw a failed press. One in ~3,400 writes is low but
it is not zero, and it will scale with concurrency — worth finding the lock ordering
that caused it before this runs at 1,000 users for real.

## What this test did NOT reach — and why

`stk_ledger +0`. `inv_allocations +0`. `whs_material_issues +0`.
`lgs_transport_requests +0`.

**No stock moved during the entire run**, so the stock locking path — the one rule 7
protects, and the one most likely to lose an update — is still completely untested.
The pipeline dries up at approval:

- 1,058–1,420 indents raised per run, but only **40–63 approvals**. The ladder parks
  each submitted indent on ONE specific approver (it climbs the raiser's own
  `parent_position_id` chain), so an indent is only approvable if that particular
  person happens to be among the users online. `starved` — the counter for "this
  persona looked for work and its queue was empty" — ran to 2,683–4,091 per run.
- Nothing downstream can start without approved indents, so allocation, material
  issue, QC outward, consignment, dispatch and acknowledgement never fired.
- Two of them could not have fired anyway: **none of the eight job-profile roles in
  this data holds `issue.post`**, and the clone contains zero `whs_material_issues`
  rows to begin with.

That is a limitation of the fixture, not a finding about the code. Fixing it needs a
seeding step that plants documents already sitting at each stage — a hundred approved
indents awaiting allocation, a hundred allocations awaiting issue, and so on — so
every desk has a queue on the first second of the run. That is the next piece of work
before the stock paths can be given a number.

## Verdict on writes

- **Numbering, approval audit and stock reconciliation survived 4,175 concurrent
  document creations with one deadlock and no corruption.** That is a good result and
  it is the half people worry about.
- **Write throughput tops out at ~30/s, comfortable to ~200 concurrent writers**,
  degrading but not failing at 1,000.
- **The stock movement paths are unmeasured.** Allocation, issue, QC, dispatch and
  acknowledgement were never exercised, so nothing here says whether two storekeepers
  allocating the same shelf at the same moment produce a correct answer. Until that
  test exists, treat concurrent stock operations as unverified.
