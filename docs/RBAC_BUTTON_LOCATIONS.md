# Job Profiles — verified button locations (audit, 2026-09-08)

`ACTION_LOCATIONS` in `frontend/src/modules/rbac/pages/JobProfilesPage.tsx` names the
control a permission actually switches on. A key there is read by code: a code nobody
grants never renders and never throws, so a wrong key is invisible. `issue.post` sat
in the map from the first pass — no such permission exists; the real one is
`issue.issue`. That is what this audit was for.

Every row below was checked three ways: the code exists in
`backend/app/platform/rbac/permissions.py`, the button carries that code in a
`<Can do=…>` in its own screen, and — where the data allowed it — the button was
photographed on the running app as `admin`.

| Permission | Button | Where | Screenshot |
|---|---|---|---|
| `indent.create` | New indent | Indents > Overview or All Requests | [03](rbac_button_locations/rbac-03-indent-create.png) |
| `indent.edit` | Edit Indent | Indents > All Requests > open a DRAFT indent | — no draft exists |
| `po.create` | New purchase order | Procurement > Purchase Orders | [04](rbac_button_locations/rbac-04-po-create.png) |
| `po.approve` | Approve | Procurement > Purchase Orders > open an order > Approve this order | — see below |
| `po.reject` | Reject | same panel as `po.approve` | — see below |
| `po.send_vendor` | Send to vendor | Procurement > Purchase Orders > open an approved order | — none to send |
| `issue.create` | New issue | Warehouse > Material Issues (same code submits a draft) | [07](rbac_button_locations/rbac-07-issue-create.png) |
| `issue.issue` | Issue from stock | Warehouse > Material Issues > open an approved issue (also Approve / Reject while pending) | [09](rbac_button_locations/rbac-09-issue-from-stock.png) |
| `rfq.create` | New RFQ | Procurement > RFQs (also [Create RFQ] on an approved requisition or consolidation) | [12](rbac_button_locations/rbac-12-procurement-actions.png) |
| `transport.create` | Dispatch | Logistics > Dispatch > a consignment row | [11](rbac_button_locations/rbac-11-logistics-actions.png) |
| `stock.points.manage` | Tag / Access / Grant access | Inventory > Stocking Points > position row > Access | [10](rbac_button_locations/rbac-10-stocking-points.png) |

The Job Profiles screen itself, and the `[New indent]` / `[Edit Indent]` badges the
map produces inside a grouped action list:
[01](rbac_button_locations/rbac-01-job-profiles.png),
[02](rbac_button_locations/rbac-02-indents-actions.png).

## The three that could not be photographed, and why

They are not unverified — the gate was read in the source and the button text matched.
What was missing was a document in the right state, and manufacturing one would have
written rows into a live-looking database to take a picture.

- **`po.approve` / `po.reject`.** The panel is drawn on `canDecide`, which is
  `awaiting_me` — not the permission. Five orders sit in approval and every one is
  pending with somebody else; the desk reads "Waiting for me: 0", so as `admin` the
  panel is correctly hidden. [05](rbac_button_locations/rbac-05-po-pending.png) is the
  queue, [06](rbac_button_locations/rbac-06-po-detail.png) an order inside it showing
  the "waiting on" line the panel is replaced by. Gate:
  `PODetailPage.tsx:636-662`.
- **`po.send_vendor`.** Needs an APPROVED order not yet sent. "To send out: 0".
  Gate: `PODetailPage.tsx:289`.
- **`indent.edit`.** Needs a DRAFT indent; the Draft filter returns nothing.
  Gate: `DetailPage.tsx:291`, already covered by
  `IndentPages.test.tsx` ("navigates Edit Indent to edit mode").

To photograph these three, log in as the named approver of PO/2026-27/00011, or raise
one draft indent and one draft PO on a test database.

## Coverage of the help text itself (2026-09-08)

The button map names the few actions that have one obvious control. The plain-language
map underneath it — `PLAIN_FEATURE_HELP` — has to answer for **every** action, because
an action with no entry falls through to the backend's own wording plus the sentence
"Grants `x.y` — the backend checks this on every request". That is accurate and it is
useless to the person building a job profile.

36 of the 135 actions were falling through: the whole procurement chain ahead of the
purchase order (requisitions, RFQs, consolidation), outward QC, every logistics action,
returns routing, the mailbox, and the integration keys. All 36 now have plain help, and
the diff is checked both ways — **135 of 135 actions covered, and no entry keyed on a
code that does not exist.**

Where a plain sentence would only have echoed the backend label, it was written to add
something instead. `transport.award` says the carrier still has to accept the job;
`transport.acknowledge` says the signature is about what actually arrived.

Screenshots of the newly covered blocks:
[11 — Logistics](rbac_button_locations/rbac-11-logistics-actions.png),
[12 — Procurement](rbac_button_locations/rbac-12-procurement-actions.png).

The `jobProfiles.test.ts` suite holds this: `ACTION_LOCATIONS` keys must be real codes,
and every action code listed must produce help containing neither "Grants" nor the
backend's placeholder description.

## The previews are now IN the screen (2026-09-08)

The screenshots above are an audit record. They are also wired into Job Profiles
itself: `SHOTS` in `JobProfilesPage.tsx` maps a permission code (for an action) or a
page code (for a screen) to a file in `frontend/public/rbac/`, and `Tick` renders it
inside the same hover card that carries the words. Hovering "Create indents" now shows
the green **[+ New indent]** button; hovering "All Requests" shows the screen it opens.

Two things this deliberately does NOT do:

- **It never blocks the words.** The `<img>` hides itself on error, so a missing or
  renamed file costs the picture and nothing else. That is also why a test asserts each
  path exists on disk — a 404 is invisible to the user and would otherwise be
  indistinguishable from a control we simply never photographed. `ind_all` was exactly
  that mistake: the page code is `ind_list`.
- **It does not invent a picture.** A code with no shot shows text alone. Action shots
  are cropped to the button itself at device scale, because a 1440px screen scaled into
  a hover card is unreadable — page shots stay whole, since the screen IS the subject.

`transport.create` has a location but no preview: on this data every Dispatch row sits
at "Checking…" and the button never renders, so there was nothing honest to photograph.
