"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ProviderBadge, providerFromProfile } from "@/components/ProviderBadge";
import { card, errorText, inputClass, label, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type ProfileView } from "@/lib/api";

const EMPTY_FORM = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  supportsJsonMode: true,
  contextTokens: "128000",
};

/** The caller's provider profiles, and a form to add one. Keys are stored encrypted and shown masked. */
export function ProviderSettings() {
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setProfiles((await apiFetch<{ providers: ProfileView[] }>("/api/providers")).providers);
      } catch (e) {
        setError(errorMessage(e));
      }
    }
    void load();
  }, []);

  function update<K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await apiFetch<ProfileView>("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          model: form.model,
          supportsJsonMode: form.supportsJsonMode,
          contextTokens: Number(form.contextTokens),
        }),
      });
      setProfiles((current) => [...(current ?? []), created]);
      setForm(EMPTY_FORM);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI providers</h1>
        <p className="mt-2 text-sm text-neutral-600">
          A provider is any OpenAI-compatible chat endpoint. Examples: OpenAI <code>https://api.openai.com/v1</code>,
          Ollama on this machine <code>http://localhost:11434/v1</code>, OpenRouter{" "}
          <code>https://openrouter.ai/api/v1</code>. Documents go to a cloud provider, so pick a local one for
          confidential material.
        </p>
      </div>

      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Your profiles</h2>
        {profiles === null && !error ? <p className="text-sm text-neutral-600">Loading profiles…</p> : null}
        {profiles?.length === 0 ? <p className="text-sm text-neutral-600">No profiles yet.</p> : null}
        <ul className="divide-y divide-neutral-200">
          {profiles?.map((profile) => (
            <li key={profile.id} className="flex flex-col gap-1 py-3">
              <p className="font-medium">{profile.name}</p>
              <ProviderBadge provider={providerFromProfile(profile)} />
              <p className="text-xs text-neutral-500">
                Key {profile.apiKeyMasked} · context {profile.contextTokens.toLocaleString()} tokens · JSON mode{" "}
                {profile.supportsJsonMode ? "on" : "off"}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={add} className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Add a profile</h2>
        <div>
          <label htmlFor="p-name" className={label}>
            Name
          </label>
          <input id="p-name" className={inputClass} value={form.name} maxLength={100} required disabled={saving} onChange={(e) => update("name", e.target.value)} />
        </div>
        <div>
          <label htmlFor="p-url" className={label}>
            Base URL
          </label>
          <input id="p-url" type="url" className={inputClass} value={form.baseUrl} required disabled={saving} placeholder="https://api.openai.com/v1" onChange={(e) => update("baseUrl", e.target.value)} />
        </div>
        <div>
          <label htmlFor="p-key" className={label}>
            API key
          </label>
          <input id="p-key" type="password" autoComplete="off" className={inputClass} value={form.apiKey} required disabled={saving} onChange={(e) => update("apiKey", e.target.value)} />
          <p className="mt-1 text-xs text-neutral-500">Stored encrypted. Only the last four characters are shown afterwards.</p>
        </div>
        <div>
          <label htmlFor="p-model" className={label}>
            Model
          </label>
          <input id="p-model" className={inputClass} value={form.model} maxLength={200} required disabled={saving} onChange={(e) => update("model", e.target.value)} />
        </div>
        <div>
          <label htmlFor="p-context" className={label}>
            Context window (tokens)
          </label>
          <input id="p-context" type="number" min={1} step={1} className={inputClass} value={form.contextTokens} required disabled={saving} onChange={(e) => update("contextTokens", e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.supportsJsonMode} disabled={saving} onChange={(e) => update("supportsJsonMode", e.target.checked)} />
          The model supports JSON mode
        </label>
        <div className="flex justify-end">
          <button type="submit" className={primaryButton} disabled={saving}>
            {saving ? "Saving…" : "Add profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
