export function ApprovalPager({ page, size, total, onPage }: {
  page: number; size: number; total: number; onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size && page === 1) return null;
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3 px-2 text-sm text-muted">
    <span>Page {page} of {pages} ({total} total)</span>
    <span className="flex gap-2">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Previous</button>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-lg border border-line px-3 py-1.5 font-medium text-body disabled:opacity-40">Next</button>
    </span>
  </div>;
}
