"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { card, errorText, inputClass, label, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage } from "@/lib/api";

/** Starts a breakdown: the epic text and an optional existing epic. The run's inputs are added on its own page. */
export function NewRunForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [epicText, setEpicText] = useState("");
  const [existingEpicKey, setExistingEpicKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const run = await apiFetch<{ id: string }>(`/api/projects/${projectId}/runs`, {
        method: "POST",
        body: JSON.stringify({ epicText: epicText.trim(), existingEpicKey: existingEpicKey.trim() || null }),
      });
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={create} className={`${card} flex flex-col gap-5`}>
      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor="epic-text" className={label}>
          Epic text
        </label>
        <textarea
          id="epic-text"
          className={inputClass}
          rows={10}
          value={epicText}
          disabled={submitting}
          onChange={(e) => setEpicText(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="existing-epic" className={label}>
          Add to existing epic (optional)
        </label>
        <input
          id="existing-epic"
          className={inputClass}
          placeholder="For example ABC-12"
          value={existingEpicKey}
          disabled={submitting}
          onChange={(e) => setExistingEpicKey(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryButton} disabled={submitting || epicText.trim() === ""}>
          {submitting ? "Creating…" : "Create run"}
        </button>
        <Link href={`/projects/${projectId}`} className="text-sm font-medium text-neutral-800 underline">
          Back to project
        </Link>
      </div>
    </form>
  );
}
