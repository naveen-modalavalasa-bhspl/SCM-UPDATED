# Project-wise approval ladders

**Date:** 2026-07-29
**Status:** built
**Screen:** Settings → Approvals Config (`/admin/approvals-config`) — a new screen.
The existing *Approval Workflows* and *Approval & Automation* screens are untouched.

---

## The problem

Today an indent raised by A Bala Raju (MMU Pilot) climbs the whole HCM position tree:

```
MMU Pilot → OE → District Manager → Regional Manager → SPH → COO
```

Nobody configured that. It is the fallback — `engine._next_reporting_ladder_approvers`
takes one `REPORTING_MANAGER` stage and auto-walks `hcm_positions.parent_position_id`
until it reaches the top.

The business needs the ladder editable **per project, per document**. For the AP-104
MMU project the OE and District Manager rungs come off, so an indent raised by anyone
below the Regional Manager goes straight to the RM, then SPH, then COO.

## The core decision: a rung is a RANK

A rung names `hcm_positions.role_id` — HCM's org role, which describes what someone
*is*. (Emphatically not `rbac_roles`, which decides what they may *do*.)

So **a project's ladder is an ordered list of ranks, each ON or OFF.**

```
Project: AP 104 - Mobile Medical Unit     Document: Indent
  ⬤ COO ..................... ON     DVD Prasad
  ⬤ SPH ..................... ON     NARESH BABU METTA
  ⬤ REGIONAL MANAGER ........ ON     Himaja Sai Vaani Ganta +2
  ○ DISTRICT MANAGER ....... OFF     S Harshavardhan Reddy +25
  ○ OE ..................... OFF     Duggipogu Sandeep Kumar +70
  ○ MMU PILOT .............. OFF     Kurapati Sai Raju +855
```

This settles three problems at once:

- **Which Regional Manager?** Never a question. We walk the raiser's own
  `parent_position_id` chain and stop at the first ancestor whose rank is on, so it is
  always *his* RM. Verified against live data: a pilot at Amarthluru reaches the
  **Ongole** RM, not Kadapa's.
- **A new project?** Ranks are shared across projects, positions are not. A project
  with no ladder gets one auto-built from the ranks its own people hold, everything ON.
- **Disabling a rung** is a toggle, not a delete. History stays readable.

### Why not the two obvious alternatives

Both were rejected against the live mirror, not on principle:

- **`hcm_position_levels`** is too coarse. Seven bands over 3,729 positions, and **COO
  and SPH both sit on Level-3** — a level-keyed rung cannot tell them apart, so
  switching one off switches off the other. `role_id` is set on all 3,729 rows and has
  18 distinct values that read exactly like the ladder.
- **A typed list of positions** breaks the moment a project has five District Managers,
  and needs a hand-written "don't route below the raiser" rule.

### Rank order

`role_id` is an identifier, not a sequence, and `level_order` puts COO and SPH on the
same band. Rank order is therefore **depth in the position tree** — how far below the
root a rank's positions sit.

Taken as the **most common** depth per rank, not the shallowest: HCM's tree has
orphans, and one parentless District Manager post would otherwise hoist the whole rank
up beside the COO. That bug was real and caught against live data.

## Routing

At submit:

1. The project comes from the post the raiser is acting under — except HCM leaves
   `hcm_positions.project_id` empty on every row, so in practice it falls through to
   `hcm_employees.project_id`. Both paths are in `ladder.project_for()`.
2. Load the ladder for `(project_id, doc_type)` → the company-wide ladder
   (`project_id IS NULL`) → today's auto-climb safety net.
3. Walk up from the raiser's position via `parent_position_id`. At each ancestor, if
   its rank is ON, that ancestor becomes a stage and its holders are the approvers.
4. Rank OFF, or the rung has no holders → skip, keep climbing.
5. Nothing above → the raiser is at the top → **self-approved**, recorded as an
   explicit `APPROVED` action with a "top of ladder" comment.

Worked example, OE and District Manager off:

| Raiser | Resolved chain |
|---|---|
| A Bala Raju (MMU Pilot) | RM → SPH → COO |
| T Bethaiah (OE) | RM → SPH → COO |
| V Suresh Kumar (DM) | RM → SPH → COO |
| Shaik Ikbal (RM) | SPH → COO |
| DVD Prasad (COO) | *(self-approved)* |

Nobody can route below themselves, because we only ever walk upward.

**A raiser with no position never self-approves.** An empty climb reads as "top of the
ladder", and someone holding no post has an empty climb for a different reason — they
take the old path and land on the fallback's admin safety net.

## Freezing the chain

The resolved chain is written onto `wf_instances.resolved_chain` (JSON) at submit —
not just the workflow id, the actual ordered list of positions. Editing a ladder
therefore cannot move a document already in approval. Saving creates **version N+1**;
the old version keeps its running documents and is retired, never deleted.

## Conditions

A rung may carry `wf_stage_conditions` rows. One rule:

```
rung applies  =  conditions pass          if the rung has conditions
              =  is_enabled               otherwise
```

That covers both jobs — gating an enabled rung, and force-including a disabled one
("over ₹5,00,000, always include the COO"). Collapsed and empty by default.

## Data model

`wf_workflows` += `project_id` (NULL = company default), `project_name`, `module`.
`wf_stages` += `position_role_id` (indexed), `is_enabled`. A stage carrying
`position_role_id` is a ladder rung; the engine's ladder path only activates for those,
so every pre-existing workflow behaves exactly as before.
`wf_instances` += `project_id`, `resolved_chain` (JSON).

Migrations: `b1c2d3e4f5a6` (columns), `c2d3e4f5a6b7` (`position_level_id` →
`position_role_id`).

## Screen

Two dropdowns and a list of toggles.

- **Project** selector; **Document** selector grouped by module.
- The rank list, highest first, each with a toggle, the real holders' names, and a red
  warning on any rank nobody holds — the dead-rung check for when an HCM sync removes
  the last position at a rank.
- A live preview: pick a starting rank, see the resolved chain, recomputed on every
  toggle before anything is saved.
- Save confirms: *"Creates version N. X documents already in approval finish on the
  current version."*
- **Copy to another project**, matched by rank; a rank the target has no holders at is
  dropped.
- Advanced conditions per rung, collapsed.

Permission: `admin.workflow.manage` (admin only).

Live rows are added by `scripts/provision_approvals_config.py` — a targeted insert,
because `scripts.seed` prunes the page tree and destroys real data.

## Out of scope

- Return/reject semantics — unchanged (returns to the previous rung).
- Retiring the older Approval Workflows / Approval & Automation screens.
