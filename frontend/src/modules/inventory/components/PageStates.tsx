import { Skeleton } from "@heroui/react";
import { AlertTriangle } from "lucide-react";

/** Skeleton lines shown while a list loads. A bare "Loading…" reads as stuck;
 *  moving bars say the screen is working. */
export function LoadingRows({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 p-4 ${className}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

/** One friendly line when something goes wrong. No stack traces for the floor. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
