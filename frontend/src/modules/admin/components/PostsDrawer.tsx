/** The chairs this system owns, and who sits in them.
 *
 *  A slide-over rather than its own screen: posts only exist to be put on a chain, so
 *  they are edited without leaving the chain you are building.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus, X } from "lucide-react";

import { Button, ErrorBanner, Field, Input, Select, useToast, selectOnFocus } from "@/shared/components";
import { adminApi } from "../api";
import type { ApprovalPost, ApprovalPostMember } from "../types";

export function PostsDrawer({ onClose }: { onClose: () => void }) {
  const [editing, setEditing] = useState<ApprovalPost | "new" | null>(null);

  return (
    <Drawer
      title={editing ? (editing === "new" ? "New post" : editing.name) : "Posts"}
      onBack={editing ? () => setEditing(null) : undefined}
      onClose={onClose}
    >
      {editing ? (
        <PostForm
          post={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <PostList onEdit={setEditing} />
      )}
    </Drawer>
  );
}

function Drawer({ title, onBack, onClose, children }: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        className="flex-1 bg-black/25"
        onClick={onClose}
      />
      <aside className="flex w-full max-w-md flex-col bg-content1 shadow-xl">
        <header className="flex min-h-14 items-center gap-2 border-b border-line/70 px-4">
          {onBack && (
            <button type="button" aria-label="Back" onClick={onBack}
                    className="grid h-11 w-8 place-items-center text-muted hover:text-body">
              <ChevronLeft size={18} />
            </button>
          )}
          <h2 className="flex-1 truncate text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}
                  className="grid h-11 w-8 place-items-center text-muted hover:text-body">
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

function PostList({ onEdit }: { onEdit: (post: ApprovalPost | "new") => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  // Retired chairs are hidden by default and shown on demand. A retired post is
  // skipped at submit time (custom_ladder._local_post_rung) AND missing from the rung
  // picker, so a chain that names one silently falls through to the fallback — the
  // admin has to be able to see that it happened and undo it.
  const [showRetired, setShowRetired] = useState(false);
  const posts = useQuery({
    queryKey: ["approval-posts", showRetired],
    queryFn: () => adminApi.approvalPosts.list(showRetired),
  });
  const refreshPosts = () => {
    queryClient.invalidateQueries({ queryKey: ["approval-posts"] });
    queryClient.invalidateQueries({ queryKey: ["approval-flow-rungs"] });
    queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
  };
  const retire = useMutation({
    mutationFn: (id: number) => adminApi.approvalPosts.retire(id),
    onSuccess: () => { toast.success("Post retired"); refreshPosts(); },
  });
  // Restoring is the same save the form does, with the flag turned back on. The
  // seating is sent unchanged so a restore never quietly empties the chair.
  const restore = useMutation({
    mutationFn: (post: ApprovalPost) => adminApi.approvalPosts.update(post.id, {
      name: post.name,
      department: post.department,
      rbac_role_id: post.rbac_role_id,
      employee_ids: post.members.map((m) => m.id),
      is_active: true,
    }),
    onSuccess: () => { toast.success("Post restored"); refreshPosts(); },
  });

  const groups = new Map<string, ApprovalPost[]>();
  for (const post of posts.data ?? []) {
    const key = post.department || "Other";
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={posts.error ?? retire.error ?? restore.error} />
      <div className="flex items-center justify-between gap-2">
        <Button variant="soft" onClick={() => onEdit("new")}>
          <Plus size={16} className="mr-1.5" /> New post
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
          />
          Show retired
        </label>
      </div>

      {[...groups.entries()].map(([group, items]) => (
        <section key={group}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
            {group}
          </h3>
          <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
            {items.map((post) => (
              <li key={post.id} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => onEdit(post)}
                  className="min-w-0 flex-1 py-1 text-left"
                >
                  <p className={`truncate text-sm font-medium ${post.is_active === false ? "text-muted line-through" : ""}`}>
                    {post.name}
                  </p>
                  {post.is_active === false && (
                    <p className="truncate text-xs text-warn">
                      Retired — any chain naming it skips this step
                    </p>
                  )}
                  <p className="truncate text-xs text-muted">
                    {post.members.length
                      ? post.members.map((m) => m.name).join(", ")
                      : <span className="text-warn">Nobody seated</span>}
                  </p>
                  {post.rbac_role_id == null && (
                    <p className="truncate text-xs text-warn">
                      No access — a step on the ladder, but no screens
                    </p>
                  )}
                </button>
                {post.is_active === false ? (
                  <button
                    type="button"
                    onClick={() => restore.mutate(post)}
                    className="h-11 shrink-0 px-2 text-xs font-medium text-brand hover:underline"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Retire ${post.name}`}
                    /* Asked first. Retiring is one click on a bare X and it takes the
                     * chair out of every chain that names it — silently, because a
                     * retired rung is skipped at submit time rather than refused. */
                    title={post.used_in_ladders > 0
                      ? `On ${post.used_in_ladders} chain(s)` : "Retire"}
                    onClick={() => {
                      const used = post.used_in_ladders > 0
                        ? ` It is on ${post.used_in_ladders} chain(s), which will skip this step.`
                        : "";
                      if (window.confirm(`Retire ${post.name}?${used}`)) {
                        retire.mutate(post.id);
                      }
                    }}
                    className="grid h-11 w-8 shrink-0 place-items-center text-muted hover:text-bad"
                  >
                    <X size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {(posts.data?.length ?? 0) === 0 && !posts.isLoading && (
        <p className="py-8 text-center text-sm text-muted">No posts yet</p>
      )}
    </div>
  );
}

function PostForm({ post, onDone }: { post: ApprovalPost | null; onDone: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(post?.name ?? "");
  const [department, setDepartment] = useState(post?.department ?? "");
  const [profileId, setProfileId] = useState<number | null>(post?.rbac_role_id ?? null);
  const [members, setMembers] = useState<ApprovalPostMember[]>(post?.members ?? []);
  const [search, setSearch] = useState("");

  const people = useQuery({
    queryKey: ["approval-post-people", search],
    queryFn: () => adminApi.approvalPosts.employees(search),
    enabled: search.trim().length >= 2,
  });
  const profiles = useQuery({
    queryKey: ["approval-post-profiles"],
    queryFn: adminApi.approvalPosts.profiles,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, department: department || null,
        rbac_role_id: profileId,
        employee_ids: members.map((m) => m.id),
      };
      return post
        ? adminApi.approvalPosts.update(post.id, body)
        : adminApi.approvalPosts.create(body);
    },
    onSuccess: () => {
      toast.success(`${name} saved`);
      queryClient.invalidateQueries({ queryKey: ["approval-posts"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-rungs"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      onDone();
    },
  });

  const unseated = (people.data ?? []).filter(
    (person) => !members.some((m) => m.id === person.id));

  return (
    <div className="space-y-4">
      <ErrorBanner error={save.error} />
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="SCM Head" />
      </Field>
      <Field label="Group">
        <Input value={department} onChange={(e) => setDepartment(e.target.value)}
               placeholder="SCM" />
      </Field>
      <Field
        label="Access"
        hint="Anyone seated here gets this. Remove them and they lose it again."
      >
        <Select
          ariaLabel="Job profile"
          value={profileId ?? ""}
          placeholder="No access — ladder step only"
          onChange={(value) => setProfileId(value ? Number(value) : null)}
          options={[
            { value: "", label: "No access — ladder step only" },
            ...(profiles.data ?? [])
              .filter((profile) => profile.is_active)
              .map((profile) => ({
                value: String(profile.id),
                label: profile.name,
              })),
          ]}
        />
      </Field>

      <div>
        <p className="mb-1.5 text-sm font-medium">People</p>
        {members.length > 0 && (
          <ul className="mb-2 space-y-1">
            {members.map((member) => (
              <li key={member.id}
                  className="flex items-center gap-2 rounded-md border border-line/70 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.name}
                  {member.code && <span className="text-muted"> · {member.code}</span>}
                  {member.is_stale && <span className="text-warn"> · not in HCM</span>}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => setMembers(members.filter((m) => m.id !== member.id))}
                  className="grid h-11 w-7 shrink-0 place-items-center text-muted hover:text-bad"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Input
          placeholder="Search name or employee code…"
          value={search}
          onFocus={selectOnFocus}
          onChange={(e) => setSearch(e.target.value)}
        />
        {unseated.length > 0 && (
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-line/70">
            {unseated.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center px-2.5 text-left text-sm hover:bg-content2"
                  onClick={() => { setMembers([...members, person]); setSearch(""); }}
                >
                  <span className="flex-1 truncate">{person.name}</span>
                  {person.code && (
                    <span className="ml-2 shrink-0 text-xs text-muted">{person.code}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
