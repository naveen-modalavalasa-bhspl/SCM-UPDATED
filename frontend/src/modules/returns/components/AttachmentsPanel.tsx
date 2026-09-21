import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, FileText, Images } from "lucide-react";
import { Button, ErrorBanner } from "@/shared/components";
import { SectionCard } from "./DetailChrome";
import { api } from "@/shared/api/client";
import { returnsApi } from "../api";
import { DOCUMENT_CATEGORY, PHOTO_CATEGORY, type StagedAttachment } from "../types";

/**
 * Photographs of the material, and the paperwork that came with it (GRN, inward bill).
 *
 * Two modes, because `sys_attachments` is keyed by document id:
 *  - `returnId` is null (a brand new return): the picked files are held in the parent's
 *    state and posted the moment the draft exists. The raiser attaches the photo while
 *    looking at the stock instead of being told to save a draft first and come back.
 *  - `returnId` exists: each pick uploads straight away, as before.
 *
 * Uploads are only offered while the return is still a draft: once it is submitted the
 * evidence is what the approvers saw, and the backend refuses a late change anyway.
 * Hiding the control is UX; the guard in `service.add_file` is the real one.
 *
 * `embedded` (2026-09-07) drops the card and the heading so the raise form can put this
 * inside its own numbered step without nesting a card in a card. Same component, same
 * rules — the detail page keeps the standalone card it has always drawn. The pattern is
 * the Fulfilment Desk's: render the original component with `embedded`, never keep a
 * second copy of its rules.
 */
export function AttachmentsPanel({
  returnId,
  editable,
  staged = [],
  onStagedChange,
  photoRequired = false,
  embedded = false,
}: {
  returnId: number | null;
  editable: boolean;
  staged?: StagedAttachment[];
  onStagedChange?: (files: StagedAttachment[]) => void;
  photoRequired?: boolean;
  /** Drawn inside somebody else's card: no `Card`, no heading of its own. */
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const photoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  // Only used to key the staged rows. Two picks of the same file name must not collide.
  const nextKey = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const { data: files = [], isLoading } = useQuery({
    queryKey: ["returns", returnId, "attachments"],
    queryFn: () => returnsApi.attachments(returnId as number),
    enabled: returnId !== null,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["returns", returnId, "attachments"] });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      returnsApi.upload(returnId as number, file, category),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err: any) =>
      setError(err?.response?.data?.error ?? "That file could not be uploaded."),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) =>
      returnsApi.removeAttachment(returnId as number, attachmentId),
    onSuccess: refresh,
    onError: (err: any) =>
      setError(err?.response?.data?.error ?? "That file could not be removed."),
  });

  const pick = (event: React.ChangeEvent<HTMLInputElement>, category: string) => {
    const chosen = Array.from(event.target.files ?? []);
    if (returnId === null) {
      onStagedChange?.([
        ...staged,
        ...chosen.map((file) => ({ key: `s${nextKey.current++}`, file, category })),
      ]);
    } else {
      // Uploaded one at a time on purpose: the endpoint takes a single file, and a
      // multi-file POST silently kept only the first.
      chosen.forEach((file) => upload.mutate({ file, category }));
    }
    // Clearing the input is what lets the same file be picked again after a failure.
    event.target.value = "";
  };

  const dropStaged = (key: string) =>
    onStagedChange?.(staged.filter((row) => row.key !== key));

  // Revoked on unmount: an object URL held for every thumbnail leaks the file until the
  // tab is closed, and a storekeeper attaching phone photos adds several MB a time.
  const previews = useMemo(
    () =>
      Object.fromEntries(
        staged
          .filter((row) => row.file.type.startsWith("image/"))
          .map((row) => [row.key, URL.createObjectURL(row.file)]),
      ),
    [staged],
  );
  useEffect(
    () => () => Object.values(previews).forEach((url) => URL.revokeObjectURL(url)),
    [previews],
  );

  const photos = files.filter((file) => file.doc_category === PHOTO_CATEGORY);
  const documents = files.filter((file) => file.doc_category !== PHOTO_CATEGORY);
  const stagedPhotos = staged.filter((row) => row.category === PHOTO_CATEGORY);
  const missingPhoto = photoRequired && photos.length + stagedPhotos.length === 0;
  const nothingAtAll = files.length === 0 && staged.length === 0;

  // SCM HEAD needs to see what the storekeeper photographed. Existing photos
  // were only listed by name, so the decision was made blind. Fetch each photo
  // as a blob and show it inline - the download route is gated by RETURN_VIEW
  // and the return's own visibility, so only someone who can read the return
  // can pull its bytes.
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next: Record<number, string> = {};
      for (const file of photos) {
        if (!file.file_name.match(/\.(png|jpg|jpeg|gif|webp|bmp|heic|heif)$/i)) continue;
        if (returnId == null) continue;
        try {
          const res = await api.get(`/api/returns/${returnId}/attachments/${file.id}/download`, {
            responseType: "blob",
          });
          if (cancelled) return;
          next[file.id] = URL.createObjectURL(res.data);
        } catch {
          // Preview is best-effort - the file row still shows and can be downloaded.
        }
      }
      if (!cancelled) setPhotoUrls(next);
    };
    if (photos.length) void load();
    return () => {
      cancelled = true;
      Object.values(photoUrls).forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.map((f) => f.id).join(","), returnId]);

  // Revoke when the component unmounts or photos change
  useEffect(() => () => Object.values(photoUrls).forEach((url) => URL.revokeObjectURL(url)), [photoUrls]);

  const inner = (
    <>
      {error && <ErrorBanner error={error} />}

      {editable && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          {/* `capture` is what opens the camera straight away on a phone, which is how
           * a storekeeper photographs damaged stock standing at the rack. */}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(event) => pick(event, PHOTO_CATEGORY)}
          />
          <input
            ref={docInput}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(event) => pick(event, DOCUMENT_CATEGORY)}
          />
          {/* The indent acknowledgement screen's own picker: a full-width dashed target
            * with the camera on it, not a bordered button. Same words, and the same
            * shape as the "Add photo" control a storekeeper already uses to prove a
            * delivery arrived — this is the same act from the other end. A 44px
            * bordered button read as secondary chrome on a card whose whole purpose is
            * that one press. */}
          <button
            type="button"
            onClick={() => photoInput.current?.click()}
            className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-2 text-sm font-semibold transition hover:border-brand hover:bg-brand-050 hover:text-brand ${
              missingPhoto
                ? "border-bad/50 bg-bad-bg/40 text-bad"
                : "border-line bg-content1 text-body"
            }`}
          >
            <Camera className="h-4 w-4" />
            Add photo of the stock{photoRequired ? " *" : ""}
          </button>
          <button
            type="button"
            onClick={() => docInput.current?.click()}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-4 py-2 text-sm font-semibold text-body transition hover:border-brand hover:bg-brand-050 hover:text-brand"
          >
            <FileText className="h-4 w-4" />
            Add GRN / inward bill
          </button>
        </div>
      )}

      {missingPhoto && (
        <p className="mb-3 text-sm font-medium text-danger">
          A photo of the stock is required before this return can be submitted.
        </p>
      )}

      {isLoading && <p className="text-sm text-muted">Loading…</p>}

      {!isLoading && nothingAtAll && !missingPhoto && (
        <p className="text-sm text-muted">
          {editable
            ? "Nothing attached yet. A photo of the material and the inward bill help the approver decide."
            : "No photos or documents were attached to this return."}
        </p>
      )}

      {staged.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
            To be attached
          </div>
          <ul className="space-y-2">
            {staged.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 p-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {previews[row.key] && (
                    <img
                      src={previews[row.key]}
                      alt={row.file.name}
                      className="h-10 w-10 rounded object-cover"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {row.file.name}
                    </div>
                    <div className="text-xs text-muted">
                      {row.category === PHOTO_CATEGORY ? "Stock photo" : "Document"}
                      {row.file.size ? ` · ${Math.round(row.file.size / 1024)} KB` : ""}
                    </div>
                  </div>
                </div>
                {editable && (
                  <Button variant="dangerSoft" onClick={() => dropStaged(row.key)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Uploaded when you save the draft or submit.
          </p>
        </div>
      )}

      {[
        { label: "Photos", rows: photos },
        { label: "Documents", rows: documents },
      ]
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <div key={group.label} className="mb-4 last:mb-0">
            <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </div>
            <ul className="space-y-2">
              {group.rows.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 p-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {group.label === "Photos" && photoUrls[file.id] && (
                      <img
                        src={photoUrls[file.id]}
                        alt={file.file_name}
                        className="h-12 w-12 rounded object-cover border border-line"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">
                        {file.file_name}
                      </div>
                      <div className="text-xs text-muted">
                        {file.uploaded_by_name ?? "—"}
                        {file.file_size ? ` · ${Math.round(file.file_size / 1024)} KB` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {group.label === "Photos" && photoUrls[file.id] && (
                      <Button
                        variant="subtle"
                        onClick={() => window.open(photoUrls[file.id], "_blank")}
                      >
                        View
                      </Button>
                    )}
                    {editable && (
                      <Button
                        variant="dangerSoft"
                        onClick={() => remove.mutate(file.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </>
  );

  // The raise form supplies its own numbered heading and card, so `embedded` hands back
  // the contents bare. The detail page keeps the standalone card and its `font-display`
  // heading, which is the scale every other panel beside it uses.
  if (embedded) return inner;

  return (
    <SectionCard icon={<Images className="h-4 w-4" />} title="Photos & documents">
      {inner}
    </SectionCard>
  );
}
