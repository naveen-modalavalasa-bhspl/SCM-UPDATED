import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, MessageCircle, Send, Sparkles } from "lucide-react";
import { Input, useToast } from "@/shared/components";
import { Button } from "./ActionButton";
import { errorMessage } from "@/shared/api/errors";
import { rfqApi, supplierApi } from "../api";
import type { QuoteComment } from "../types";

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

/**
 * The discussion beside one quotation — the supplier's paper.
 *
 * One thread per quotation, and a quotation already answers to exactly one
 * supplier on one RFQ, so "unique to that supplier" is the table's shape, not a
 * feature of this component. Both sides post into the same thread; the tint of a
 * bubble is read off `author_side`, which the server wrote at post time, so the
 * screen never guesses from an id.
 *
 * `side` says who is READING: their own messages go right, the counterparty's
 * go left. Same pattern as the PO approval chat, pointed at the counterparty.
 */
export function QuotationChat({
  rfqId, quotationId, vendorName, side, defaultCollapsed = side === "SUPPLIER",
}: {
  rfqId?: number;
  quotationId: number;
  /** Shown in the subtitle and on the counterparty's bubbles. */
  vendorName?: string | null;
  /** "BUYER" (employee side) or "SUPPLIER" (portal side). */
  side: "BUYER" | "SUPPLIER";
  defaultCollapsed?: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [isOpen, setIsOpen] = useState(!defaultCollapsed);

  const targetId = side === "SUPPLIER" ? (rfqId || quotationId) : quotationId;

  const chat = useQuery({
    queryKey: ["quote-comments", quotationId],
    queryFn: () => rfqApi.quoteComments(quotationId),
    enabled: side === "BUYER" && Number.isFinite(quotationId) && quotationId > 0,
    refetchInterval: 15000,
  });

  // The portal reads the same thread through its own scoped route.
  const vendorChat = useQuery({
    queryKey: ["supplier-quote-comments", targetId],
    queryFn: () => supplierApi.quoteComments(targetId),
    enabled: side === "SUPPLIER" && Number.isFinite(targetId) && targetId > 0,
    refetchInterval: 15000,
  });

  const post = useMutation({
    mutationFn: () => side === "BUYER"
      ? rfqApi.postQuoteComment(quotationId, draft.trim())
      : supplierApi.postQuoteComment(targetId, draft.trim()),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["quote-comments", quotationId] });
      queryClient.invalidateQueries({ queryKey: ["supplier-quote-comments", targetId] });
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  const items: QuoteComment[] =
    side === "BUYER" ? chat.data ?? [] : vendorChat.data ?? [];

  if (!isOpen) {
    return (
      <div className="overflow-hidden rounded-2xl border border-pink-200 bg-gradient-to-r from-pink-600 via-rose-500 to-pink-700 shadow-md transition-all hover:shadow-lg">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center justify-between px-5 py-4 text-white hover:bg-white/5 transition-colors text-left"
        >
          <div className="flex items-center gap-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 backdrop-blur shadow-inner">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 text-base font-bold tracking-tight text-white">
                {side === "SUPPLIER" ? "Chat with Buyer" : "Price discussion"}{" "}
                <Sparkles className="h-4 w-4 opacity-90 text-pink-200" />
              </div>
              <div className="text-xs font-medium text-pink-100/90 mt-0.5">
                {side === "SUPPLIER"
                  ? "Click to open conversation & messages with the buyer"
                  : `with ${vendorName ?? "the supplier"} · stays with this quotation`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/20 px-3.5 py-2 text-xs font-bold text-white backdrop-blur shadow-sm border border-white/20 hover:bg-white/30 transition">
            <span>Open Chat</span>
            {items.length > 0 && (
              <span className="rounded-full bg-white text-pink-700 px-2 py-0.5 text-[10px] font-extrabold">
                {items.length}
              </span>
            )}
            <ChevronDown className="h-4 w-4" />
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-pink-200/50 bg-gradient-to-br from-pink-600 via-rose-500 to-pink-700 shadow-xl">
      <div className="bg-white/10 backdrop-blur border-b border-white/10">
        <div className="flex items-center justify-between px-5 py-3.5 text-white">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 backdrop-blur shadow-inner">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 text-sm font-bold tracking-tight text-white">
                {side === "SUPPLIER" ? "Chat with Buyer" : "Price discussion"}{" "}
                <Sparkles className="h-3.5 w-3.5 opacity-80 text-pink-200" />
              </div>
              <div className="text-xs font-medium text-pink-100/90">
                with {vendorName ?? "the supplier"} · stays with this quotation
              </div>
            </div>
          </div>
          {defaultCollapsed && (
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-1.5 rounded-xl bg-white/20 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/30 transition border border-white/20"
              title="Hide chat"
            >
              <span>Hide</span>
              <ChevronUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto bg-black/10 px-5 py-4 backdrop-blur-sm">
        {items.length === 0 && (
          <div className="py-8 text-center text-xs font-medium text-pink-100">
            <p className="font-semibold text-sm text-white">No messages yet</p>
            <p className="mt-1 text-pink-100/80">
              Ask about rates, delivery or terms. The whole thread is kept with the quotation.
            </p>
          </div>
        )}
        {items.map((c) => {
          const mine = (c.author_side ?? "BUYER") === side;
          return (
            <div key={c.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-xs shadow-md ${
                mine
                  ? "rounded-br-sm bg-white/25 text-white backdrop-blur border border-white/30"
                  : "rounded-bl-sm bg-white text-gray-900 border border-pink-100/80"}`}>
                {!mine && (
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-pink-600">
                    {c.author_name ?? (side === "SUPPLIER" ? "Buyer" : "Supplier")}
                  </div>
                )}
                <p className="whitespace-pre-wrap text-xs font-normal leading-relaxed break-words">{c.message}</p>
                <div className={`mt-1.5 text-right text-[10px] font-medium ${mine ? "text-pink-100/80" : "text-gray-400"}`}>
                  {timeAgo(c.created_at)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2.5 border-t border-white/15 bg-white/10 px-4 py-3 backdrop-blur">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
              e.preventDefault();
              post.mutate();
            }
          }}
          placeholder={side === "BUYER"
            ? "Ask the supplier about this quote…"
            : "Reply to the buyer…"}
          aria-label="Message"
          className="bg-white/95 text-gray-900 placeholder:text-gray-400 border-white/30 focus:border-pink-400 text-xs font-medium h-10"
        />
        <Button
          className="shrink-0 h-10 px-4 bg-white/20 hover:bg-white/30 text-white font-semibold border border-white/30 shadow-sm"
          disabled={!draft.trim() || post.isPending}
          onClick={() => post.mutate()}
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
