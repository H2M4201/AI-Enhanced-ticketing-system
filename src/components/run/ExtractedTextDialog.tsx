"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Spinner } from "@/components/run/Spinner";
import { card, errorText, secondaryButton } from "@/components/styles";
import { apiFetch, errorMessage } from "@/lib/api";
import type { Section } from "@/core/domain";

type Props = {
  runId: string;
  documentId: string;
  filename: string;
  onClose: () => void;
};

type Loaded = { sections: Section[] | null };

/** The text the parser extracted from one document, section by section, with each section's reference. */
export function ExtractedTextDialog({ runId, documentId, filename, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog when it opens, so keyboard users start inside it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function closeOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") onClose();
  }

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const doc = await apiFetch<Loaded>(`/api/runs/${runId}/documents/${documentId}`);
        if (current) setLoaded({ sections: doc.sections });
      } catch (e) {
        if (current) setError(errorMessage(e));
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [runId, documentId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extracted-title"
        tabIndex={-1}
        onKeyDown={closeOnEscape}
        className={`${card} flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 focus:outline-none`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="extracted-title" className="min-w-0 truncate text-lg font-semibold">
            Extracted text: {filename}
          </h2>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto">
          {error ? (
            <p role="alert" className={errorText}>
              {error}
            </p>
          ) : null}
          {!error && loaded === null ? <Spinner label="Loading text…" /> : null}
          {loaded?.sections === null ? (
            <p className="text-sm text-neutral-600">This document&apos;s text was removed by the retention policy.</p>
          ) : null}
          {loaded?.sections?.map((section) => (
            <section key={section.ref} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-neutral-800">
                {section.ref}
                {section.heading ? ` · ${section.heading}` : ""}
              </h3>
              <p className="whitespace-pre-wrap text-sm text-neutral-800">{section.text}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
