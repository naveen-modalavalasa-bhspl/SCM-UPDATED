import { test, expect } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers, type Account } from "../../src/config.js";

/**
 * The MDP/LIP chain, end to end and watchable.
 *
 * Run headed with a pause between actions so a human can follow along:
 *   SLOW_MO=1500 npx playwright test tests/stocking-points-flow --headed
 *
 * Nothing is seeded. The spec discovers the real stocking points and positions,
 * tags them through the actual screen, and asserts the derived movement kinds — so
 * a pass means the live data supports the flow, not that a fixture did. Every tag
 * it creates is removed at the end, because tagging widens what other people can
 * see and a test must not leave that behind.
 */

const users = loadUsers();
const admin: Account = users.admin ?? users.raiser;

interface Warehouse {
  id: number;
  code: string;
  name: string;
  warehouse_type: string;
}

interface Classification {
  movement_kind: string;
  doc_type: string;
  needs_inventory_manager: boolean;
  explanation: string;
}

const TAG_MARKER = "Playwright Project";

test.describe("Stocking points — tiers, tagging and movement classification", () => {
  test("every movement kind is derived from its two points", async ({ page, api, log, goto, capture }) => {
    const all = await log.runStep(
      "Read the live stocking points",
      () => api.getAs<{ items?: Warehouse[] }>("/api/warehouses?size=200", admin)
        .then((body) => body.items ?? (body as unknown as Warehouse[])),
    );
    const typeOf = (w: Warehouse) => (w.warehouse_type ?? "").toUpperCase();
    const mdps = all.filter((w) => typeOf(w) === "MDP");
    const lips = all.filter((w) => typeOf(w) === "LIP");
    const tops = all.filter((w) => !["MDP", "LIP"].includes(typeOf(w)));

    log.info(`tiers: warehouses=${tops.length} mdps=${mdps.length} lips=${lips.length}`);
    // Skipping is the honest outcome when the live data cannot express the rule: a
    // green tick on absent data proves nothing, and the message names what is short.
    test.skip(
      mdps.length < 2 || lips.length < 1 || tops.length < 1,
      `Needs >=1 warehouse, >=2 MDPs and >=1 LIP. Found ${tops.length}/${mdps.length}/${lips.length}.`,
    );

    const [mdpA, mdpB] = mdps;
    const [lip] = lips;
    const [top] = tops;

    const classify = (from: number, to: number) =>
      api.getAs<Classification>(
        `/api/stocking-points/classify?from_warehouse_id=${from}&to_warehouse_id=${to}`, admin,
      );

    await test.step("The four kinds, from the geometry alone", async () => {
      const cases: Array<[string, number, number, string]> = [
        [`${top.name} down to ${mdpA.name}`, top.id, mdpA.id, "ISSUE"],
        [`${mdpA.name} down to ${lip.name}`, mdpA.id, lip.id, "ISSUE"],
        [`${mdpA.name} across to ${mdpB.name}`, mdpA.id, mdpB.id, "TRANSFER"],
        [`${lip.name} back up to ${mdpA.name}`, lip.id, mdpA.id, "RETURN"],
        [`inside ${mdpA.name}`, mdpA.id, mdpA.id, "MOVEMENT"],
      ];
      for (const [label, from, to, expected] of cases) {
        const result = await classify(from, to);
        log.info(`classify: ${label} => ${result.movement_kind} — ${result.explanation}`);
        expect(result.movement_kind, label).toBe(expected);
      }
    });

    // One position can hold several points — that is the whole reason the tagging is
    // a table rather than a column — so the same position tags both MDPs here, and
    // only their PROJECT differs. That isolates the cross-project rule from
    // everything else.
    // The admin may be a pure system account with no post, so the spec walks the
    // configured logins until it finds one that actually holds a position.
    let positionId: number | null = null;
    let positionName: string | null = null;
    for (const candidate of [admin, ...(users.approvers ?? []), users.raiser]) {
      // /api/auth/me answers with an `active_position` OBJECT (and a `positions`
      // list), not a flat id — a person can hold several posts and the scope
      // follows the active one.
      const me = await api.getAs<{
        active_position?: { id?: number; position_id?: number; name?: string | null } | null;
        positions?: { id?: number; position_id?: number; name?: string | null }[];
      }>("/api/auth/me", candidate).catch(() => null);
      const post = me?.active_position ?? me?.positions?.[0];
      const id = post?.position_id ?? post?.id;
      if (id) {
        positionId = id;
        positionName = post?.name ?? candidate.label;
        break;
      }
    }
    test.skip(!positionId, "No configured login holds a position, so nothing can be tagged.");

    await test.step("Tag a position through the screen", async () => {
      await loginAs(page, admin, log);
      await goto("/inventory/stocking-points", "Stocking points");
      await capture("stocking-points-before");

      await page.getByLabel("Position id").fill(String(positionId));

      // The stocking point picker is a HeroUI Autocomplete: a text box that filters
      // a listbox, so it has to be typed into and then chosen from — filling alone
      // leaves the form with no selection and the Tag button disabled.
      // By role, not by label: the results table below has a "Stocking point"
      // column header, so a label lookup is ambiguous once a row exists.
      const picker = page.getByRole("combobox", { name: "Stocking point" });
      await picker.click();
      await picker.fill(mdpA.name.slice(0, 12));
      await page.getByRole("option", { name: new RegExp(mdpA.name.slice(0, 12), "i") })
        .first().click();

      await page.getByLabel("Project id").fill("101");
      await page.getByLabel("Project name").fill(`${TAG_MARKER} A`);

      const tagButton = page.getByRole("button", { name: "Tag", exact: true });
      await expect(tagButton, "Tag is enabled once a position and a point are chosen")
        .toBeEnabled();
      await tagButton.click();

      // The row appears carrying the tier the WAREHOUSE declares, never one typed here.
      await expect(page.getByText(`${TAG_MARKER} A`).first()).toBeVisible({ timeout: 15_000 });
      await capture("stocking-points-after-tag");
      log.info(`tagged: position ${positionId} (${positionName})`);
    });

    await test.step("Crossing a project boundary pulls in the Inventory Manager", async () => {
      await api.postAs("/api/stocking-points/tags", {
        position_id: positionId, warehouse_id: mdpA.id,
        project_id: 101, project_name: `${TAG_MARKER} A`,
      }, admin);
      await api.postAs("/api/stocking-points/tags", {
        position_id: positionId, warehouse_id: mdpB.id,
        project_id: 101, project_name: `${TAG_MARKER} A`,
      }, admin);

      const same = await classify(mdpA.id, mdpB.id);
      log.info(`same-project: ${same.explanation}`);
      expect(same.needs_inventory_manager, "same project is the holder's own call").toBe(false);

      // Same two points; only the far one's project changes.
      await api.postAs("/api/stocking-points/tags", {
        position_id: positionId, warehouse_id: mdpB.id,
        project_id: 202, project_name: `${TAG_MARKER} B`,
      }, admin);

      const cross = await classify(mdpA.id, mdpB.id);
      log.info(`cross-project: ${cross.explanation}`);
      expect(cross.movement_kind, "still a transfer").toBe("TRANSFER");
      expect(cross.needs_inventory_manager, "crossing projects needs a referee").toBe(true);
      expect(cross.doc_type).toBe("STOCK_TRANSFER");

      await goto("/inventory/stocking-points", "Stocking points after tagging");
      await capture("stocking-points-two-projects");
    });

    await test.step("Remove every tag this spec created", async () => {
      const tags = await api.getAs<{ id: number; project_name?: string | null }[]>(
        "/api/stocking-points/tags", admin,
      );
      for (const tag of tags) {
        if (tag.project_name?.startsWith(TAG_MARKER)) {
          await api.deleteAs(`/api/stocking-points/tags/${tag.id}`, admin);
          log.info(`cleanup: removed tag ${tag.id}`);
        }
      }
      const left = await api.getAs<{ project_name?: string | null }[]>(
        "/api/stocking-points/tags", admin,
      );
      expect(left.filter((t) => t.project_name?.startsWith(TAG_MARKER))).toHaveLength(0);
    });
  });
});
