import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Camera, CarFront, CheckCircle2, Gauge, Image as ImageIcon, Lock, Phone, Route, Users,
} from "lucide-react";
import { Button, Card, Input, errorMessage, useToast } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import type { OdometerPhoto, TransportRequest } from "../transportTypes";

/**
 * An own-vehicle shipment's trip card (2026-11-20): the vehicle, everyone on it, and
 * the odometer at both ends.
 *
 * The two readings are the trip's own evidence, so each is a figure AND a photo of
 * the dial. START is taken before the vehicle leaves (and can be corrected until it
 * does); END once the trip is done, never below START. The service refuses to release
 * the load without START and to mark it delivered without END — this card is where
 * both are given, and says which one is due next.
 */
const LEFT = new Set(["IN_TRANSIT", "DELIVERED", "ACKNOWLEDGED", "CLOSED"]);

export function OwnVehicleTrip({ doc }: { doc: TransportRequest }) {
  const left = LEFT.has(doc.status) || Boolean(doc.dispatched_at);
  const photos = doc.odometer_photos ?? { ODOMETER_START: [], ODOMETER_END: [] };
  const distance = doc.distance_travelled_km;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 bg-content2/40 px-4 py-3">
        <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink">
          <CarFront className="h-4 w-4 text-brand" aria-hidden /> Own vehicle trip
        </h2>
        {distance != null && (
          <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2.5 py-1 text-xs font-bold text-ok">
            <Route className="h-3.5 w-3.5" aria-hidden /> {distance.toLocaleString("en-IN")} km travelled
          </span>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-mono font-semibold text-ink">{doc.vehicle_number || "—"}</span>
          {doc.vehicle_type_name && <span className="text-muted">· {doc.vehicle_type_name}</span>}
        </div>

        <section aria-label="Crew">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {doc.crew?.length ? `${doc.crew.length} on board` : "Crew"}
          </h3>
          {doc.crew?.length ? (
            <ul className="divide-y divide-line/60 rounded-xl border border-line/70">
              {doc.crew.map((person) => (
                <li key={person.id} className="flex items-center gap-3 px-3 py-2">
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
                    person.role === "DRIVER" ? "bg-brand text-white" : "bg-content3 text-ink"}`}>
                    {person.sequence}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink">
                      {person.name}
                      {person.role === "DRIVER" && (
                        <span className="ml-1.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand">Driver</span>
                      )}
                    </div>
                    {person.id_number && <div className="truncate text-[11px] text-muted">{person.id_number}</div>}
                  </div>
                  <a href={`tel:${person.phone}`}
                     className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/5">
                    <Phone className="h-3.5 w-3.5" aria-hidden /> {person.phone}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Nobody named yet — add the crew on the Dispatch screen.</p>
          )}
        </section>

        <section aria-label="Odometer" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ReadingTile trId={doc.id} reading="START" title="Start reading"
                       value={doc.odometer_start} at={doc.odometer_start_at} by={doc.odometer_start_by_name}
                       photos={photos.ODOMETER_START}
                       open={!left}
                       closedNote="Fixed once the vehicle left."
                       due={!left && doc.odometer_start == null}
                       dueNote="Needed before the vehicle leaves." />
          <ReadingTile trId={doc.id} reading="END" title="End reading"
                       value={doc.odometer_end} at={doc.odometer_end_at} by={doc.odometer_end_by_name}
                       photos={photos.ODOMETER_END}
                       open={left}
                       min={doc.odometer_start ?? undefined}
                       closedNote="Recorded once the trip is done."
                       due={left && doc.odometer_end == null}
                       dueNote="Needed before it is marked delivered." />
        </section>
      </div>
    </Card>
  );
}

function ReadingTile({
  trId, reading, title, value, at, by, photos, open, min, closedNote, due, dueNote,
}: {
  trId: number; reading: "START" | "END"; title: string;
  value?: number | null; at?: string | null; by?: string | null;
  photos: OdometerPhoto[]; open: boolean; min?: number;
  closedNote: string; due: boolean; dueNote: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const recorded = value != null;
  const showForm = open && (editing || !recorded);
  const number = draft.trim() === "" ? null : Number(draft);
  const tooLow = number != null && min != null && number < min;
  const needsPhoto = photos.length === 0 && !file;
  const canSave = number != null && Number.isFinite(number) && number >= 0 && !tooLow && !needsPhoto;

  const save = useMutation({
    mutationFn: () => transportApi.recordOdometer(trId, reading, number!, file),
    onSuccess: (doc) => {
      qc.setQueryData(["transport", String(trId)], doc);
      qc.invalidateQueries({ queryKey: ["transport", String(trId)] });
      setEditing(false); setDraft(""); setFile(null);
      toast.success(`${title} saved — ${number?.toLocaleString("en-IN")} km.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const view = async (photo: OdometerPhoto) => {
    const blob = await transportApi.downloadDocument(trId, photo.id);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };

  return (
    <div className={`rounded-xl border p-3 ${due ? "border-warn/40 bg-warn-bg/40" : recorded ? "border-ok/25 bg-ok-bg/30" : "border-line"}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
          <Gauge className="h-3.5 w-3.5" aria-hidden /> {title}
        </span>
        {recorded && !showForm && (open
          ? <button type="button" className="min-h-8 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/5"
                    onClick={() => { setEditing(true); setDraft(String(value)); }}>Correct</button>
          : <Lock className="h-3.5 w-3.5 text-muted" aria-label={closedNote} />)}
      </div>

      {recorded && !showForm && (
        <>
          <div className="flex items-baseline gap-1.5">
            <CheckCircle2 className="h-4 w-4 self-center text-ok" aria-hidden />
            <span className="text-xl font-bold tabular-nums text-ink">{value!.toLocaleString("en-IN")}</span>
            <span className="text-xs text-muted">km</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">{[by, fmtDateTime(at, "")].filter(Boolean).join(" · ")}</p>
        </>
      )}

      {!recorded && !showForm && <p className="text-xs text-muted">{closedNote}</p>}

      {showForm && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="decimal" min={min ?? 0} step="0.1" value={draft}
                   placeholder={min != null ? `${min} or more` : "e.g. 45210"}
                   aria-label={`${title} in km`} className="text-base font-semibold"
                   onChange={(e) => setDraft(e.target.value)} />
            <span className="text-xs text-muted">km</span>
          </div>
          <input ref={fileInput} type="file" accept="image/*" capture="environment" className="hidden"
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" onClick={() => fileInput.current?.click()}
                  className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 text-xs font-semibold ${
                    file ? "border-ok/40 bg-ok-bg/40 text-ok" : "border-brand/40 text-brand hover:bg-brand/5"}`}>
            <Camera className="h-4 w-4" aria-hidden />
            {file ? `Photo ready — ${file.name}` : photos.length ? "Replace the dial photo (optional)" : "Take a photo of the dial"}
          </button>
          {tooLow && <p className="text-xs font-semibold text-danger">Cannot be less than the start reading ({min} km).</p>}
          {due && <p className="text-[11px] text-warn">{dueNote}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => save.mutate()} disabled={!canSave || save.isPending}
                    title={needsPhoto ? "Add a photo of the dial" : undefined}>
              {save.isPending ? "Saving…" : `Save ${title.toLowerCase()}`}
            </Button>
            {recorded && (
              <Button variant="ghost" onClick={() => { setEditing(false); setDraft(""); setFile(null); }}>Cancel</Button>
            )}
          </div>
        </div>
      )}

      {photos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {photos.slice(0, 3).map((photo) => (
            <button key={photo.id} type="button" onClick={() => void view(photo)}
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line bg-content1 px-2 text-[11px] font-medium text-body hover:text-ink">
              <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Dial photo
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
