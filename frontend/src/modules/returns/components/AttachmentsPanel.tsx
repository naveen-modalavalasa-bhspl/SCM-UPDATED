import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorBanner } from "@/shared/components";
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
 */
export function AttachmentsPanel({
  returnId,
  editable,
  staged = [],
  onStagedChange,
  photoRequired = false,
}: {
  returnId: number | null;
  editable: boolean;
  staged?: StagedAttachment[];
  onStagedChange?: (files: StagedAttachment[]) => void;
  photoRequired?: boolean;
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

  return (
    <Card className="p-4">
      <h2 className="mb-3 font-display text-lg font-bold text-ink">
        Photos &amp; documents
      </h2>

      {error && <ErrorBanner error={error} />}

      {editable && (
        <div className="mb-4 flex flex-wrap gap-2">
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
          <Button variant="subtle" onClick={() => photoInput.current?.click()}>
            Add photo of the stock{photoRequired ? " *" : ""}
          </Button>
          <Button variant="subtle" onClick={() => docInput.current?.click()}>
            Add GRN / inward bill
          </Button>
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
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
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
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              {group.label}
            </div>
            <ul className="space-y-2">
              {group.rows.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 p-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {file.file_name}
                    </div>
                    <div className="text-xs text-muted">
                      {file.uploaded_by_name ?? "—"}
                      {file.file_size ? ` · ${Math.round(file.file_size / 1024)} KB` : ""}
                    </div>
                  </div>
                  {editable && (
                    <Button
                      variant="dangerSoft"
                      onClick={() => remove.mutate(file.id)}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </Card>
  );
}
