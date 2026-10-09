import { Link, useLocation } from "react-router-dom";
import { Compass, ShieldOff } from "lucide-react";
import { Button, Card } from "@/shared/components";

/**
 * What a URL with no screen behind it says.
 *
 * Both of these used to be `<Navigate to="/" replace />`: an unknown address and an
 * address the login is not granted both dumped the user on Home with nothing said,
 * which reads as the app losing the click. Saying which of the two happened is the
 * difference between "I mistyped it" and "I need someone to give me access".
 */
function Shell({ icon, title, detail, path }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  path: string;
}) {
  return (
    <div className="mx-auto max-w-lg py-12">
      <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-050 text-brand">
          {icon}
        </span>
        <div className="font-display text-lg font-semibold text-ink">{title}</div>
        <p className="max-w-sm text-sm text-muted">{detail}</p>
        <p className="max-w-full break-all font-mono text-[11px] text-muted">{path}</p>
        <Link to="/" className="mt-2">
          <Button variant="primary">Back to Home</Button>
        </Link>
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  const path = useLocation().pathname;
  return (
    <Shell
      icon={<Compass className="h-6 w-6" />}
      title="No screen at this address"
      detail="The link may be out of date, or the address may have a typo in it."
      path={path}
    />
  );
}

export function ForbiddenPage() {
  const path = useLocation().pathname;
  return (
    <Shell
      icon={<ShieldOff className="h-6 w-6" />}
      title="You don't have access to this screen"
      detail="Your role does not include this page. An administrator can grant it if you need it."
      path={path}
    />
  );
}
