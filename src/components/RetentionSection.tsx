"use client";

import { useState } from "react";
import { errorText, inputClass, label, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage } from "@/lib/api";

type Props = {
  projectId: string;
  retentionDays: number;
  canEdit: boolean;
  onChanged: () => Promise<void>;
};

/** How many days uploaded documents and drafts are kept before the purge removes them. Owner only. */
export function RetentionSection({ projectId, retentionDays, canEdit, onChanged }: Props) {
  const [days, setDays] = useState(String(retentionDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return <p className="text-sm text-neutral-700">Kept for {retentionDays} days. Only the owner can change this.</p>;
  }

  async function save() {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1) {
      setError("Enter a whole number of days, at least 1.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ retentionDays: value }) });
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-600">
        Uploaded documents and drafts are removed after this many days.
      </p>
      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="retention" className={label}>
            Days to keep
          </label>
          <input
            id="retention"
            type="number"
            min={1}
            step={1}
            className={`${inputClass} w-32`}
            value={days}
            disabled={saving}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <button type="button" className={primaryButton} disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save retention"}
        </button>
      </div>
    </div>
  );
}
