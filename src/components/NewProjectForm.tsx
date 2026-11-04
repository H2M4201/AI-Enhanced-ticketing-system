"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { card, errorText, inputClass, label, primaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type JiraProjectView, type ProjectView, type SiteView } from "@/lib/api";

/** Pick a Jira site, then a Jira project on it, name the project, and create it. */
export function NewProjectForm() {
  const router = useRouter();
  const [sites, setSites] = useState<SiteView[] | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProjectView[] | null>(null);
  const [cloudId, setCloudId] = useState("");
  const [jiraKey, setJiraKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadSites() {
      try {
        setSites((await apiFetch<{ sites: SiteView[] }>("/api/sites")).sites);
      } catch (e) {
        setError(errorMessage(e));
      }
    }
    void loadSites();
  }, []);

  async function chooseSite(value: string) {
    setCloudId(value);
    setJiraKey("");
    setJiraProjects(null);
    setError(null);
    if (!value) return;
    try {
      const response = await apiFetch<{ projects: JiraProjectView[] }>(
        `/api/sites/${encodeURIComponent(value)}/projects`,
      );
      setJiraProjects(response.projects);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function chooseJiraProject(key: string) {
    setJiraKey(key);
    const picked = jiraProjects?.find((p) => p.key === key);
    if (picked && name.trim() === "") setName(picked.name);
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const project = await apiFetch<ProjectView>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ cloudId, jiraProjectKey: jiraKey, name: name.trim() }),
      });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  const ready = cloudId !== "" && jiraKey !== "" && name.trim() !== "";

  return (
    <form onSubmit={create} className={`${card} flex flex-col gap-5`}>
      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor="site" className={label}>
          Jira site
        </label>
        <select
          id="site"
          className={inputClass}
          value={cloudId}
          disabled={!sites || submitting}
          onChange={(e) => void chooseSite(e.target.value)}
        >
          <option value="">{sites ? "Choose a site" : "Loading sites…"}</option>
          {sites?.map((site) => (
            <option key={site.cloudId} value={site.cloudId}>
              {site.name} ({site.url})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="jira-project" className={label}>
          Jira project
        </label>
        <select
          id="jira-project"
          className={inputClass}
          value={jiraKey}
          disabled={!jiraProjects || submitting}
          onChange={(e) => chooseJiraProject(e.target.value)}
        >
          <option value="">
            {cloudId === "" ? "Choose a site first" : jiraProjects ? "Choose a Jira project" : "Loading projects…"}
          </option>
          {jiraProjects?.map((project) => (
            <option key={project.id} value={project.key}>
              {project.key} · {project.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="name" className={label}>
          Project name in this app
        </label>
        <input
          id="name"
          className={inputClass}
          value={name}
          maxLength={200}
          disabled={submitting}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex justify-end">
        <button type="submit" className={primaryButton} disabled={!ready || submitting}>
          {submitting ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}
