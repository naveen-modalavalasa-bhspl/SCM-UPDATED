import { Construction } from "lucide-react";
import { PageHeader, Card } from "@/shared/components/ui";

/** Module-owned stand-in until a module's screens are built. The Indents module is
 * the reference pattern the others follow. */
export function Placeholder({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-050 text-brand">
          <Construction className="h-6 w-6" />
        </span>
        <div>
          <p className="font-semibold text-body">{title} screens are coming next.</p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            {note ?? "The backend for this module is live and tested. Its pages follow the Indents module as the reference pattern."}
          </p>
        </div>
      </Card>
    </>
  );
}
