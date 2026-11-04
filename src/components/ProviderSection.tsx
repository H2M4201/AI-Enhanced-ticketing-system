"use client";

import { useState } from "react";
import { ProviderOrNone, type ProviderInfo } from "@/components/ProviderBadge";
import { errorText, inputClass, label, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type ProfileView } from "@/lib/api";

type Props = {
  projectId: string;
  /** The provider the project uses now, as the server resolves it. Null when none is configured. */
  provider: ProviderInfo | null;
  providerProfileId: string | null;
  profiles: ProfileView[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
};

const NO_PROFILE = "";

/**
 * Shows the provider in use for everyone. The owner also picks which of their profiles the project uses.
 */
export function ProviderSection({ projectId, provider, providerProfileId, profiles, canEdit, onChanged }: Props) {
  const [choice, setChoice] = useState(providerProfileId ?? NO_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ providerProfileId: choice === NO_PROFILE ? null : choice }),
      });
      await onChanged();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <ProviderOrNone provider={provider} />
        <p className="text-neutral-600">Only the project owner can change the provider.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}
      <ProviderOrNone provider={provider} />
      <div>
        <label htmlFor="provider" className={label}>
          Provider profile
        </label>
        <select
          id="provider"
          className={inputClass}
          value={choice}
          disabled={saving}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value={NO_PROFILE}>No profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model}
            </option>
          ))}
        </select>
        <p className="mt-2 text-sm text-neutral-600">
          With no profile, the project uses the server default if one is configured.
        </p>
        {profiles.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            You have no provider profiles yet. Add one on the AI providers page.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={primaryButton}
          disabled={saving || choice === (providerProfileId ?? NO_PROFILE)}
          onClick={save}
        >
          {saving ? "Saving…" : "Save provider"}
        </button>
        {saved ? <span className="text-sm text-neutral-600">Saved.</span> : null}
      </div>
    </div>
  );
}
