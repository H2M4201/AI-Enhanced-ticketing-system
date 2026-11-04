"use client";

import { useState, type ChangeEvent } from "react";
import { FileList } from "@/components/FileList";
import { card, errorText, secondaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type FileView } from "@/lib/api";

/** Names the server accepts. The server checks again; this only gives an early message. */
const ACCEPTED_NAME = /\.(md|txt)$/i;

type Props = {
  projectId: string;
  kind: FileView["kind"];
  title: string;
  help: string;
  files: FileView[];
  /** Every member can upload. Only the owner can remove. The server enforces both. */
  canRemove: boolean;
  templateHref: string;
  templateName: string;
  onChanged: () => Promise<void>;
};

/** One kind of project file: its list, an upload control and a starter template link. */
export function FilesSection({
  projectId,
  kind,
  title,
  help,
  files,
  canRemove,
  templateHref,
  templateName,
  onChanged,
}: Props) {
  const listed = files.filter((file) => file.kind === kind);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replacing = kind === "routing" && listed.length > 0;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_NAME.test(file.name)) {
      setError("Upload a .md or .txt file.");
      return;
    }
    setError(null);
    setBusy("upload");
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      await apiFetch(`/api/projects/${projectId}/files`, { method: "POST", body: form });
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(fileId: string) {
    setError(null);
    setBusy(fileId);
    try {
      await apiFetch(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" });
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`${card} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-neutral-600">{help}</p>
        </div>
        <a href={templateHref} download className="text-sm font-medium text-neutral-800 underline">
          {templateName}
        </a>
      </div>

      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}

      <FileList files={listed} onRemove={canRemove ? remove : undefined} removingId={busy} />

      <label className={`${secondaryButton} w-fit cursor-pointer ${busy === "upload" ? "opacity-60" : ""}`}>
          {busy === "upload" ? "Uploading…" : replacing ? "Replace routing file" : "Upload .md or .txt"}
          <input
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            className="sr-only"
            disabled={busy !== null}
            onChange={upload}
          />
      </label>
    </section>
  );
}
