"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FilesSection } from "@/components/FilesSection";
import { ProviderSection } from "@/components/ProviderSection";
import { RetentionSection } from "@/components/RetentionSection";
import { card, errorText, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type FileView, type ProfileView, type ProjectView } from "@/lib/api";

type Loaded = { project: ProjectView; files: FileView[]; profiles: ProfileView[] };

function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

/** Loads one project with its files and, for the owner, the caller's provider profiles. */
export function ProjectDetail({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to load again after a change. Each section awaits it before it returns.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const project = await apiFetch<ProjectView>(`/api/projects/${projectId}`);
        const [files, profiles] = await Promise.all([
          apiFetch<{ files: FileView[] }>(`/api/projects/${projectId}/files`),
          project.owned ? apiFetch<{ providers: ProfileView[] }>("/api/providers") : Promise.resolve({ providers: [] }),
        ]);
        if (!current) return;
        setLoaded({ project, files: files.files, profiles: profiles.providers });
        setError(null);
      } catch (e) {
        if (current) setError(errorMessage(e));
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [projectId, version]);

  const reload = useCallback(async () => setVersion((v) => v + 1), []);

  if (error) {
    return (
      <p role="alert" className={errorText}>
        {error}
      </p>
    );
  }
  if (!loaded) return <p className="text-neutral-600">Loading project…</p>;

  const { project, files, profiles } = loaded;
  const canEdit = project.owned;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="text-sm text-neutral-600">
            {project.jiraProjectKey} on {siteHost(project.siteUrl)}
            {canEdit ? "" : " · read-only: owned by another user"}
          </p>
        </div>
        <Link href={`/projects/${project.id}/runs/new`} className={primaryButton}>
          Start a new breakdown
        </Link>
      </div>

      <FilesSection
        projectId={project.id}
        kind="guideline"
        title="Guideline files"
        help="How stories, acceptance criteria, sizing and ticket structure should look. Upload one or more .md or .txt files."
        files={files}
        canEdit={canEdit}
        templateHref="/templates/guidelines-template.md"
        templateName="Download starter template"
        onChanged={reload}
      />

      <FilesSection
        projectId={project.id}
        kind="routing"
        title="Routing file"
        help="Teams, people and routing rules. A project has one active routing file; uploading a new one replaces it."
        files={files}
        canEdit={canEdit}
        templateHref="/templates/routing-template.md"
        templateName="Download routing template"
        onChanged={reload}
      />

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">AI provider</h2>
        <ProviderSection
          projectId={project.id}
          providerProfileId={project.providerProfileId}
          profiles={profiles}
          canEdit={canEdit}
          onChanged={reload}
        />
      </section>

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Retention</h2>
        <RetentionSection projectId={project.id} retentionDays={project.retentionDays} canEdit={canEdit} onChanged={reload} />
      </section>
    </div>
  );
}
