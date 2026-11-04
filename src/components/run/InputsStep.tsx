"use client";

import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import { ExtractedTextDialog } from "@/components/run/ExtractedTextDialog";
import { Spinner } from "@/components/run/Spinner";
import { FileList } from "@/components/FileList";
import { ProviderOrNone, type ProviderInfo } from "@/components/ProviderBadge";
import { card, errorText, primaryButton, secondaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type FileView } from "@/lib/api";
import type { RunDocumentView } from "@/server/runs/service";

/** Document types the run reads. The server checks the content again. */
const ACCEPT = ".docx,.pptx,.pdf,.txt,.md";
const ACCEPTED_NAME = /\.(docx|pptx|pdf|txt|md)$/i;

type Upload = { key: string; name: string; status: "uploading" | "done" | "error"; message: string | null };

type Props = {
  projectId: string;
  runId: string;
  epicText: string;
  existingEpicKey: string | null;
  documents: RunDocumentView[];
  provider: ProviderInfo | null;
  /** The project's active guideline and routing files, listed read-only. */
  guidelines: FileView[];
  routing: FileView[];
  /** What is running now, such as "Running checks…". Null when idle. */
  busy: string | null;
  onRunChecks: () => void;
  onDocumentsChanged: () => Promise<void>;
};

/** The run's inputs: the epic, its documents, the project's files and the provider. Nothing here is checked until Run checks. */
export function InputsStep({
  projectId,
  runId,
  epicText,
  existingEpicKey,
  documents,
  provider,
  guidelines,
  routing,
  busy,
  onRunChecks,
  onDocumentsChanged,
}: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [docError, setDocError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; filename: string } | null>(null);
  const noProvider = provider === null;

  async function uploadOne(file: File, key: string) {
    const update = (patch: Partial<Upload>) =>
      setUploads((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
    if (!ACCEPTED_NAME.test(file.name)) {
      update({ status: "error", message: "Upload a .docx, .pptx, .pdf, .txt or .md file." });
      return;
    }
    try {
      const form = new FormData();
      form.set("file", file);
      await apiFetch(`/api/runs/${runId}/documents`, { method: "POST", body: form });
      update({ status: "done", message: null });
      await onDocumentsChanged();
    } catch (e) {
      update({ status: "error", message: errorMessage(e) });
    }
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    const batch = picked.map((file, index) => ({ file, key: `${Date.now()}-${index}-${file.name}` }));
    setUploads((current) => [
      ...current,
      ...batch.map(({ file, key }) => ({ key, name: file.name, status: "uploading" as const, message: null })),
    ]);
    // Sequential, so the server handles one parse at a time and per-file results arrive in order.
    for (const { file, key } of batch) {
      await uploadOne(file, key);
    }
    setUploads((current) => current.filter((entry) => entry.status === "error"));
  }

  async function remove(documentId: string) {
    setDocError(null);
    setRemovingId(documentId);
    try {
      await apiFetch(`/api/runs/${runId}/documents/${documentId}`, { method: "DELETE" });
      await onDocumentsChanged();
    } catch (e) {
      setDocError(errorMessage(e));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={`${card} flex flex-col gap-3`}>
        <h2 className="text-lg font-semibold">Epic</h2>
        <p className="whitespace-pre-wrap text-sm text-neutral-800">{epicText}</p>
        <p className="text-sm text-neutral-600">
          {existingEpicKey ? `Clarifications will be added to existing epic ${existingEpicKey}.` : "A new epic will be created."}
        </p>
      </section>

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Documents</h2>
        <p className="text-sm text-neutral-600">Add the documents that describe the epic. Each one is parsed when you upload it.</p>

        {docError ? (
          <p role="alert" className={errorText}>
            {docError}
          </p>
        ) : null}

        {documents.length === 0 ? (
          <p className="text-sm text-neutral-500">No documents added yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">{doc.filename}</p>
                  <p className="text-xs text-neutral-500">
                    {doc.kind} · {doc.charCount.toLocaleString()} characters
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setViewing({ id: doc.id, filename: doc.filename })}
                  >
                    View extracted text
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={removingId !== null || busy !== null}
                    onClick={() => void remove(doc.id)}
                  >
                    {removingId === doc.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {uploads.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {uploads.map((entry) => (
              <li key={entry.key} className={entry.status === "error" ? "text-red-800" : "text-neutral-700"}>
                <span className="font-medium">{entry.name}</span>:{" "}
                {entry.status === "uploading" ? "Uploading…" : entry.status === "done" ? "Added" : entry.message}
              </li>
            ))}
          </ul>
        ) : null}

        <label className={`${secondaryButton} w-fit cursor-pointer`}>
          Upload documents
          <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={uploadFiles} />
        </label>
      </section>

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Project files</h2>
        <p className="text-sm text-neutral-600">
          These come from the project page and are read when you run checks.{" "}
          <Link href={`/projects/${projectId}`} className="font-medium underline">
            Change them on the project page
          </Link>
          .
        </p>
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-neutral-800">Guidelines</h3>
          <FileList files={guidelines} removingId={null} />
          <h3 className="text-sm font-semibold text-neutral-800">Routing</h3>
          <FileList files={routing} removingId={null} />
        </div>
      </section>

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">AI provider</h2>
        <ProviderOrNone provider={provider} />
        {noProvider ? (
          <p className="text-sm text-neutral-700">
            <Link href={`/projects/${projectId}`} className="font-medium underline">
              Set up a provider on the project page
            </Link>
            .
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButton} onClick={onRunChecks} disabled={noProvider || busy !== null}>
          Run checks
        </button>
        {busy ? <Spinner label={busy} /> : null}
      </div>

      {viewing ? (
        <ExtractedTextDialog
          runId={runId}
          documentId={viewing.id}
          filename={viewing.filename}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
