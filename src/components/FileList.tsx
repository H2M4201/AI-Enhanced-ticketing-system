import { secondaryButton } from "@/components/styles";
import type { FileView } from "@/lib/api";

type Props = {
  files: FileView[];
  /** Omitted for a read-only list. */
  onRemove?: (fileId: string) => void;
  removingId: string | null;
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/** The active files of one kind, with version and upload date. */
export function FileList({ files, onRemove, removingId }: Props) {
  if (files.length === 0) {
    return <p className="text-sm text-neutral-500">No files uploaded yet.</p>;
  }
  return (
    <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
      {files.map((file) => (
        <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-900">{file.filename}</p>
            <p className="text-xs text-neutral-500">
              Version {file.version} · uploaded {formatDate(file.uploadedAt)}
            </p>
          </div>
          {onRemove ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={removingId !== null}
              onClick={() => onRemove(file.id)}
            >
              {removingId === file.id ? "Removing…" : "Remove"}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
