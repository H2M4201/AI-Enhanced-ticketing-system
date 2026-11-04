"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ProviderOrNone } from "@/components/ProviderBadge";
import { card, errorText, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type ProjectView } from "@/lib/api";
import { siteHost } from "@/lib/format";

type Loaded = { projects: ProjectView[] };

export function ProjectsList() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await apiFetch<{ projects: ProjectView[] }>("/api/projects");
        setLoaded({ projects: response.projects });
      } catch (e) {
        setError(errorMessage(e));
      }
    }
    void load();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Link href="/projects/new" className={primaryButton}>
          New project
        </Link>
      </div>

      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}
      {!loaded && !error ? <p className="text-neutral-600">Loading projects…</p> : null}

      {loaded && loaded.projects.length === 0 ? (
        <div className={card}>
          <p className="text-neutral-700">No projects yet. Create one for a Jira project you can browse.</p>
        </div>
      ) : null}

      {loaded && loaded.projects.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {loaded.projects.map((project) => (
            <li key={project.id} className={card}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/projects/${project.id}`} className="font-medium text-neutral-950 hover:underline">
                    {project.name}
                  </Link>
                  <p className="text-sm text-neutral-600">
                    {project.jiraProjectKey} on {siteHost(project.siteUrl)}
                    {project.owned ? "" : " · shared with you"}
                  </p>
                </div>
                <div className="max-w-full">
                  <ProviderOrNone provider={project.provider} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
