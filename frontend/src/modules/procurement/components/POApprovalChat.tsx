import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, Sparkles } from "lucide-react";
import { Button, Input, useToast } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { poApi } from "../api";
import type { POComment } from "../types";

function timeAgo(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export function POApprovalChat({ poId }: { poId: number }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const chat = useQuery({
    queryKey: ["po-comments", poId],
    queryFn: () => poApi.comments(poId),
    enabled: Number.isFinite(poId) && poId > 0,
    refetchInterval: 15000,
  });

  const post = useMutation({
    mutationFn: () => poApi.postComment(poId, draft.trim()),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["po-comments", poId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not send message"),
  });

  const items: POComment[] = chat.data ?? [];
  const myId = me?.employee?.id as number | undefined;

  return (
    <div className="overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-br from-teal-500 via-cyan-500 to-sky-600 shadow-lg">
      <div className="bg-white/10 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-3 text-white">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 backdrop-blur">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-bold tracking-wide">
              Approval Discussion <Sparkles className="h-3.5 w-3.5 opacity-80" />
            </div>
            <div className="text-xs text-white/80">
              Approver asks, requester replies — history stays with the PO
            </div>
          </div>
          <div className="ml-auto rounded-full bg-white/20 px-2.5 py-1 text-xs font-bold">
            {items.length} {items.length === 1 ? "msg" : "msgs"}
          </div>
        </div>
      </div>

      <div className="bg-white p-3 sm:p-4">
        <div className="max-h-[340px] space-y-3 overflow-y-auto rounded-xl bg-gradient-to-b from-slate-50 to-white p-3 ring-1 ring-slate-200">
          {chat.isLoading && <p className="text-sm text-muted">Loading conversation…</p>}
          {chat.isError && <p className="text-sm text-danger">{(chat.error as Error).message}</p>}
          {!chat.isLoading && items.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center">
              <p className="text-sm font-semibold text-ink">No questions yet</p>
              <p className="mx-auto mt-1 max-w-[28ch] text-xs text-muted">
                Approver can ask for clarification; the raiser replies here. Edited
                quantities are what the vendor receives.
              </p>
            </div>
          )}
          {items.map((m) => {
            const mine = myId != null && m.author_id === myId;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm ring-1 ${
                    mine
                      ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white ring-indigo-300/30"
                      : "bg-white text-ink ring-slate-200"
                  }`}
                >
                  <div className={`mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide ${mine ? "text-white/80" : "text-muted"}`}>
                    <span>{m.author_name ?? "—"}</span>
                    <span className={`h-1 w-1 rounded-full ${mine ? "bg-white/70" : "bg-slate-300"}`} />
                    <span>{timeAgo(m.created_at)}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {m.message}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1">
            <Input
              value={draft}
              onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
              placeholder="Ask a question or reply…"
              onKeyDown={(e: any) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim() && !post.isPending) post.mutate();
                }
              }}
            />
          </div>
          <Button
            disabled={!draft.trim() || post.isPending}
            onClick={() => post.mutate()}
            className="shrink-0"
          >
            <Send className="h-4 w-4" /> {post.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Tip: Press Enter to send. Approver may trim quantities down only — increases are blocked.
        </p>
      </div>
    </div>
  );
}
