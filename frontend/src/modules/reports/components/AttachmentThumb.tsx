import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { File, FileSpreadsheet, FileText, Image as ImageIcon } from "lucide-react";
import { api } from "@/shared/api/client";
import type { AttachmentFile, AttachmentFileKind } from "../attachmentsTypes";

/** The picture itself, not an icon standing in for one.
 *
 *  An `<img src="/api/...">` cannot work here: every download route is behind a bearer
 *  token the axios client attaches, and the browser sends none on an image request — it
 *  would 401 and render a broken tile. So the bytes are fetched through the client and
 *  handed to the tag as an object URL.
 *
 *  Keyed on the download URL through TanStack Query, so the same file is fetched once
 *  no matter how many tiles and previews show it, and the cache survives paging back to
 *  a document. Only images are fetched — a PDF or a spreadsheet keeps its glyph, because
 *  downloading a 4 MB workbook to draw a 40px square is not a preview, it is a download. */

const GLYPH: Record<AttachmentFileKind, {
  icon: typeof ImageIcon; tint: string;
}> = {
  image: { icon: ImageIcon, tint: "bg-info-bg text-info" },
  pdf: { icon: FileText, tint: "bg-bad-bg text-bad" },
  document: { icon: FileSpreadsheet, tint: "bg-ok-bg text-ok" },
  other: { icon: File, tint: "bg-neutral-bg text-neutral" },
};

export const thumbKey = (url: string) => ["reports", "attachment-blob", url] as const;

export const fetchAttachmentBlob = (url: string): Promise<Blob> =>
  api.get(url, { responseType: "blob" }).then((r) => r.data as Blob);

/** An object URL for a cached blob, revoked when the tile goes away. */
function useObjectUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

export function AttachmentThumb({ file, className = "h-11 w-11" }: {
  file: AttachmentFile;
  className?: string;
}) {
  const isImage = file.file_kind === "image" && Boolean(file.download_url);
  const blob = useQuery({
    queryKey: thumbKey(file.download_url ?? ""),
    queryFn: () => fetchAttachmentBlob(file.download_url!),
    enabled: isImage,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
  const url = useObjectUrl(blob.data);
  const glyph = GLYPH[file.file_kind];
  const Icon = glyph.icon;

  // The picture when we have it; the glyph while it loads, and for good after a
  // failure — a tile that cannot fetch its bytes still has to say what kind of file
  // it is rather than sitting empty.
  if (isImage && url) {
    return (
      <img
        src={url}
        alt={file.file_name}
        loading="lazy"
        className={`${className} shrink-0 rounded-lg border border-line object-cover`}
      />
    );
  }
  return (
    <span className={`${className} grid shrink-0 place-items-center rounded-lg ${glyph.tint} ${
      isImage && blob.isLoading ? "animate-pulse" : ""
    }`}>
      <Icon className="h-4 w-4" />
    </span>
  );
}
