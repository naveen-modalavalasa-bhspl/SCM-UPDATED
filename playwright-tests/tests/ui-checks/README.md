# ui-checks

Module-by-module screen checks: buttons, form validation, empty states, disabled
states, responsive layout, accessibility. One spec per module, named after the
backend module it mirrors — `indents.spec.ts`, `inventory.spec.ts`,
`procurement.spec.ts`, `warehouse.spec.ts`.

Different question from `../indent-approval-flow/`. That suite asks *"does the
business flow complete"* and crosses several logins to answer it. This one asks
*"is each screen correct on its own"* and should not depend on a document existing.

Keep them apart: a broken Save button should fail here with a one-line message, not
show up as a stalled approval chain three logins deep.
