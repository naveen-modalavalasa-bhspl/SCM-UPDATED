import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Globe, Search, Users } from "lucide-react";
import { Button } from "@heroui/react";
import { Card, ErrorBanner, Select } from "@/shared/components";
import { itemEligibilityAssignments, itemEligibilityScopes, mastersApi,
         setItemEligibilityAssignments } from "../api";
import type { Option } from "../components/MasterCrud";

/**
 * Item Eligibility — which items a ROLE or a REGION may raise an indent for.
 *
 * Built as an ASSIGNMENT DESK, not a row-at-a-time master. The table underneath is
 * one row per (item, scope), which is the right shape for the data and the wrong
 * shape for the job: a role serves hundreds of items, and tagging them through a
 * modal one pair at a time is not a screen anybody would use twice. So this asks the
 * question the way the business asks it — "which items may this role raise?" — and
 * saves the whole answer in one call.
 *
 * READ THE DEFAULT FIRST, because it is the safety of the whole feature: an item with
 * NO tag anywhere is requestable by EVERYONE. Only a tagged item is ever narrowed. So
 * an empty table changes nothing, and this screen can only ever take things away —
 * never leave the company unable to raise an indent.
 *
 * That default has a sharp edge worth stating on screen: the moment an item gets its
 * first tag it becomes invisible to everybody else. The banner below says so, because
 * an admin ticking one box on one role would otherwise discover it from a support
 * call.
 *
 * A requester passes if they match EITHER kind of tag — tagging an item to two
 * regions and one role means "anyone in those regions, plus anyone with that role",
 * never the intersection, which nobody could satisfy.
 */

type ScopeKind = "ROLE" | "REGION";

export function ItemEligibilityTab({ items }: { items: Option[] }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ScopeKind>("ROLE");
  const [scopeId, setScopeId] = useState<string>("");
  const [search, setSearch] = useState("");
  //: The working set. Seeded from the server, edited locally, saved in one press —
  //: so ticking forty boxes is forty clicks and one request, not forty requests.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const scopes = useQuery({
    queryKey: ["masters", "item-eligibility", "scopes"],
    queryFn: itemEligibilityScopes,
    // Roles and offices change on an HCM sync, not between two edits here.
    staleTime: 5 * 60_000,
  });

  const scopeOptions = useMemo(() => (
    kind === "ROLE" ? (scopes.data?.roles ?? []) : (scopes.data?.regions ?? [])
  ).map((row) => ({ value: String(row.id), label: row.name })), [kind, scopes.data]);

  const current = useQuery({
    queryKey: ["masters", "item-eligibility", "assignments", kind, scopeId],
    queryFn: () => itemEligibilityAssignments(kind, Number(scopeId)),
    enabled: Boolean(scopeId),
  });

  // Reseed whenever the server answer changes — including after a save, so the ticks
  // on screen are always what is actually stored rather than what was typed.
  useEffect(() => {
    if (current.data) {
      setPicked(new Set(current.data.item_ids));
      setDirty(false);
    }
  }, [current.data]);

  // Which items already carry a tag from SOMEBODY. Needed for the warning: an item
  // that is untagged today is open to everyone, and ticking it here is what closes it.
  const tagged = useQuery({
    queryKey: ["masters", "item-eligibility", "tagged-ids"],
    queryFn: () => mastersApi.itemEligibility.list({ size: 500 })
      .then((page) => new Set(page.items
        .filter((row) => row.is_active)
        .map((row) => row.item_id))),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => setItemEligibilityAssignments({
      scope_type: kind, scope_id: Number(scopeId), item_ids: [...picked],
    }),
    onSuccess: (result) => {
      setSaved(
        `${result.total} item${result.total === 1 ? "" : "s"} now tagged to `
        + `${result.scope_name}`
        + (result.added || result.removed || result.restored
          ? ` (+${result.added + result.restored} / −${result.removed})` : ""));
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["masters", "item-eligibility"] });
    },
  });

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((option) =>
      String(option.label).toLocaleLowerCase().includes(needle));
  }, [items, search]);

  const toggle = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setDirty(true);
    setSaved(null);
  };

  // Acts on what is VISIBLE, not on the whole catalogue — the search box is the
  // selection tool, and "select all" that quietly ticked 300 hidden rows would be a
  // trap rather than a shortcut.
  const setAllVisible = (on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      visible.forEach((option) => {
        if (on) next.add(Number(option.value)); else next.delete(Number(option.value));
      });
      return next;
    });
    setDirty(true);
    setSaved(null);
  };

  const visibleIds = visible.map((option) => Number(option.value));
  const allVisiblePicked = visibleIds.length > 0
    && visibleIds.every((id) => picked.has(id));

  // Items this press would newly close off to everyone else.
  const newlyClosing = dirty && tagged.data
    ? [...picked].filter((id) => !tagged.data.has(id)).length
    : 0;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Tag by"
            value={kind}
            onChange={(value) => {
              setKind(value === "REGION" ? "REGION" : "ROLE");
              // The two are different id spaces — a role id is not an office id — so
              // the chosen scope cannot survive the switch.
              setScopeId("");
              setPicked(new Set());
              setDirty(false);
              setSaved(null);
            }}
            options={[
              { value: "ROLE", label: "Role" },
              { value: "REGION", label: "Region" },
            ]}
            className="w-40"
          />
          <Select
            label={kind === "ROLE" ? "Role" : "Region"}
            value={scopeId}
            onChange={(value) => { setScopeId(value); setSaved(null); }}
            options={scopeOptions}
            placeholder={kind === "ROLE" ? "Pick a role…" : "Pick a region…"}
            className="min-w-64 flex-1"
          />
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <span className="text-xs font-medium text-warn">Unsaved changes</span>
            )}
            <Button
              color="primary"
              isDisabled={!scopeId || !dirty || save.isPending}
              isLoading={save.isPending}
              onPress={() => save.mutate()}
              className="h-11 font-semibold"
            >
              {save.isPending ? "Saving…" : `Save ${picked.size} item${picked.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>

        <p className="mt-3 text-xs text-muted">
          An item tagged to nobody stays requestable by <strong>everyone</strong>.
          Tagging is how you narrow it — so this screen only ever takes access away.
        </p>
      </Card>

      <ErrorBanner error={scopes.error ?? current.error ?? save.error} />

      {saved && (
        <div className="flex items-center gap-2 rounded-xl bg-ok-bg px-4 py-3 text-sm font-medium text-ok">
          <Check className="h-4 w-4" /> {saved}
        </div>
      )}

      {newlyClosing > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {newlyClosing} of these {newlyClosing === 1 ? "items is" : "items are"} not
            tagged to anyone yet. Saving makes {newlyClosing === 1 ? "it" : "them"}
            {" "}requestable <strong>only</strong> by this{" "}
            {kind === "ROLE" ? "role" : "region"} — everyone else loses{" "}
            {newlyClosing === 1 ? "it" : "them"}.
          </span>
        </div>
      )}

      {!scopeId ? (
        <Card className="p-10 text-center">
          {kind === "ROLE"
            ? <Users className="mx-auto h-6 w-6 text-muted" />
            : <Globe className="mx-auto h-6 w-6 text-muted" />}
          <p className="mt-3 text-sm text-muted">
            Pick a {kind === "ROLE" ? "role" : "region"} to see and change what it may
            request.
          </p>
        </Card>
      ) : (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative min-w-56 flex-1">
              <span className="sr-only">Search items</span>
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search items by code or name…"
                className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
              />
            </label>
            <Button
              size="sm"
              variant="bordered"
              onPress={() => setAllVisible(!allVisiblePicked)}
              isDisabled={visibleIds.length === 0}
            >
              {allVisiblePicked ? "Clear these" : `Select these ${visibleIds.length}`}
            </Button>
            <span className="text-xs text-muted">
              {picked.size} selected of {items.length}
            </span>
          </div>

          <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-line/70">
            {visible.length === 0 && (
              <p className="py-10 text-center text-sm text-muted">
                No item matches “{search}”.
              </p>
            )}
            {visible.map((option) => {
              const id = Number(option.value);
              const on = picked.has(id);
              return (
                <label
                  key={id}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 border-b border-line/50 px-3 py-2 text-sm last:border-b-0 transition-colors ${
                    on ? "bg-brand-050/50" : "hover:bg-content2"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(id)}
                    className="h-4 w-4 shrink-0 accent-[var(--color-brand)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-body">{option.label}</span>
                  {tagged.data && !tagged.data.has(id) && (
                    <span className="shrink-0 rounded-full bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      open to all
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
