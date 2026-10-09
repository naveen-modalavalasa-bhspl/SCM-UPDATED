import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Wand2 } from "lucide-react";
import { Button, Card, Field, Input, PageHeader } from "@/shared/components";
import { alerts } from "@/modules/alerts";
import { codeFormatsApi } from "../api";
import type { CodeFormats } from "../types";

type FormatKey = "asset_format" | "consumable_format" | "serial_format";

/** What the three templates are for, in the words the store uses. */
const FORMATS: { key: FormatKey; label: string; hint: string }[] = [
  {
    key: "asset_format",
    label: "Asset code",
    hint: "Stamped on every serialised unit of an item marked as an asset, at putaway.",
  },
  {
    key: "consumable_format",
    label: "Consumable code",
    hint: "The same, for items that are not assets.",
  },
  {
    key: "serial_format",
    label: "Serial number",
    hint: "Minted at material inward for a unit that arrives without a serial on it. "
      + "A serial typed or scanned from the vendor's label is never replaced. Cannot "
      + "use {serial} — this is what generates it — and must include {seq}.",
  },
];

/** Live preview of one template, rendered by the backend so the screen can never
 *  promise a shape the dock would not produce. Debounced — it is a keystroke away
 *  from being a request per character. */
function Preview({ template, isAsset }: { template: string; isAsset: boolean }) {
  const [settled, setSettled] = useState(template);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(template), 350);
    return () => clearTimeout(timer);
  }, [template]);

  const preview = useQuery({
    queryKey: ["code-formats", "preview", settled, isAsset],
    queryFn: () => codeFormatsApi.preview(settled, isAsset),
    enabled: settled.trim().length > 0,
    retry: false,
  });

  if (!settled.trim()) {
    return <p className="text-xs text-muted">Empty — the built-in default will be used.</p>;
  }
  if (preview.isError) {
    // The rejection reason, not "invalid": the message names the offending token.
    return (
      <p className="text-xs text-danger">
        {(preview.error as Error)?.message ?? "This format cannot be used."}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted">
      Example:{" "}
      <span className="font-mono text-sm font-semibold text-ink">
        {preview.data?.preview ?? "…"}
      </span>
    </p>
  );
}

export function CodeFormatsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<CodeFormats | null>(null);

  const settings = useQuery({ queryKey: ["code-formats"], queryFn: codeFormatsApi.get });
  const tokens = useQuery({ queryKey: ["code-formats", "tokens"], queryFn: codeFormatsApi.tokens });

  const save = useMutation({
    mutationFn: codeFormatsApi.update,
    onSuccess: (data) => {
      setForm(data);
      qc.invalidateQueries({ queryKey: ["code-formats"] });
      void alerts.info("settings.changed");
    },
  });

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  if (!form) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Code Formats" />
        <Card className="p-6 text-sm text-muted">Loading…</Card>
      </>
    );
  }

  const set = <K extends keyof CodeFormats>(key: K, value: CodeFormats[K]) =>
    setForm({ ...form, [key]: value });

  const insert = (key: FormatKey, token: string) =>
    set(key, `${form[key]}${token}` as CodeFormats[typeof key]);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Code Formats"
        actions={
          <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
            <Save className="h-4 w-4" /> Save
          </Button>
        }
      />

      <p className="mb-4 text-sm text-body">
        The shape of the codes this system generates: the asset and consumable codes
        stamped at putaway, and the serial minted at material inward for a unit that
        arrives without one. Changing a format only affects units handled{" "}
        <strong>after</strong> the change — a code already printed on a label and
        quoted on documents is never re-stamped.
      </p>

      <div className="space-y-4">
        {FORMATS.map(({ key, label, hint }) => (
          <Card key={key} className="p-4">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted">
              {label}
            </h2>
            <p className="mb-3 text-xs text-muted">{hint}</p>
            <Field label="Format">
              <Input
                value={form[key]}
                aria-label={`${label} format`}
                onChange={(e) => set(key, e.target.value)}
              />
            </Field>
            <div className="mt-2">
              <Preview template={form[key]} isAsset={key === "asset_format"} />
            </div>
            {/* Click to append, so the tokens do not have to be typed exactly. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {/* {serial} is not offered on the serial template: it is the thing being
                  generated, so it would render blank and hand every unlabelled unit
                  the same string. The backend rejects it too — this only keeps the
                  screen from suggesting it. */}
              {(tokens.data?.tokens ?? [])
                .filter((t) => !(key === "serial_format" && t.token === "{serial}"))
                .map((t) => (
                <button
                  key={t.token}
                  type="button"
                  title={t.description}
                  onClick={() => insert(key, t.token)}
                  className="min-h-8 rounded-full border border-line px-3 py-1 font-mono text-xs text-body hover:border-brand hover:text-brand"
                >
                  {t.token}
                </button>
              ))}
            </div>
          </Card>
        ))}

        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted">
            New vs old items
          </h2>
          <p className="mb-3 text-xs text-muted">
            What <span className="font-mono">{"{new_flag}"}</span> renders as. An item
            created before the cutover date counts as old. Leave the date empty and
            nothing is treated as old.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="New items">
              <Input value={form.new_flag} onChange={(e) => set("new_flag", e.target.value)} />
            </Field>
            <Field label="Old items">
              <Input value={form.legacy_flag} onChange={(e) => set("legacy_flag", e.target.value)} />
            </Field>
            <Field label="Items created before">
              <Input
                type="date"
                value={form.legacy_before}
                onChange={(e) => set("legacy_before", e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
            <Wand2 className="h-4 w-4" /> Tokens
          </h2>
          <dl className="grid gap-2 md:grid-cols-2">
            {(tokens.data?.tokens ?? []).map((t) => (
              <div key={t.token} className="flex gap-3 text-sm">
                <dt className="w-32 shrink-0 font-mono text-xs text-brand">{t.token}</dt>
                <dd className="text-body">{t.description}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            A width pads or trims: <span className="font-mono">{"{serial:8}"}</span> gives
            eight characters, keeping the tail of a longer serial. Every format must
            include <span className="font-mono">{"{serial}"}</span> or{" "}
            <span className="font-mono">{"{seq}"}</span>, or two units of one item would
            get the same code.
          </p>
        </Card>

        {save.error && (
          <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {(save.error as Error).message}
          </p>
        )}
      </div>
    </>
  );
}
