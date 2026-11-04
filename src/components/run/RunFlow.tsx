"use client";

import { useEffect, useState } from "react";
import { ChecksStep } from "@/components/run/ChecksStep";
import { InputsStep } from "@/components/run/InputsStep";
import { QuestionsStep } from "@/components/run/QuestionsStep";
import { Stepper, currentStep } from "@/components/run/Stepper";
import type { RunDetail } from "@/components/run/types";
import { ReviewScreen } from "@/components/review/ReviewScreen";
import type { ProviderInfo } from "@/components/ProviderBadge";
import { errorText, secondaryButton } from "@/components/styles";
import { apiFetch, errorMessage, type FileView, type ProjectView } from "@/lib/api";
import type { Resolution } from "@/core/domain";
import type { ChecksResult } from "@/server/runs/service";

type Failure = { message: string; retry: () => void };

/** Drives one run through its steps. The run's status picks the step; the checks step opens over the inputs while results are shown. */
export function RunFlow({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [files, setFiles] = useState<FileView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checks, setChecks] = useState<ChecksResult | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const loaded = await apiFetch<RunDetail>(`/api/runs/${runId}`);
        const projectId = loaded.run.projectId;
        const [projectView, fileList] = await Promise.all([
          apiFetch<ProjectView>(`/api/projects/${projectId}`),
          apiFetch<{ files: FileView[] }>(`/api/projects/${projectId}/files`),
        ]);
        if (!current) return;
        setDetail(loaded);
        setProject(projectView);
        setFiles(fileList.files);
        setLoadError(null);
      } catch (e) {
        if (current) setLoadError(errorMessage(e));
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [runId]);

  async function reload() {
    setDetail(await apiFetch<RunDetail>(`/api/runs/${runId}`));
  }

  /** Runs one step's work with a busy label. A failure shows its message and a Retry that runs the same work again. */
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setFailure(null);
    try {
      await action();
    } catch (e) {
      setFailure({ message: errorMessage(e), retry: () => void perform(label, action) });
    } finally {
      setBusy(null);
    }
  }

  const runChecks = () =>
    perform("Running checks…", async () => {
      const result = await apiFetch<ChecksResult>(`/api/runs/${runId}/checks`, { method: "POST" });
      setChecks(result);
      setChecksOpen(true);
      await reload();
    });

  const generateQuestions = () =>
    perform("Generating questions…", async () => {
      await apiFetch(`/api/runs/${runId}/questions`, { method: "POST" });
      await reload();
    });

  const generateDraft = () =>
    perform("Generating draft…", async () => {
      await apiFetch(`/api/runs/${runId}/draft`, { method: "POST" });
      await reload();
    });

  function resolveQuestion(questionId: string, resolution: Resolution) {
    setDetail((current) =>
      current
        ? {
            ...current,
            questions: current.questions.map((question) =>
              question.id === questionId ? { ...question, resolution } : question,
            ),
          }
        : current,
    );
  }

  if (loadError) {
    return (
      <p role="alert" className={errorText}>
        {loadError}
      </p>
    );
  }
  if (!detail || !project) return <p className="text-neutral-600">Loading run…</p>;

  const status = detail.run.status;
  const provider: ProviderInfo | null = project.provider;
  const showChecks = checksOpen && checks !== null && (status === "inputs" || status === "checked");
  const step = currentStep(status, checksOpen);

  let content: React.ReactNode;
  if (showChecks && checks) {
    content = (
      <ChecksStep
        projectId={project.id}
        checks={checks}
        busy={busy}
        onRerun={() => void runChecks()}
        onContinue={() => setChecksOpen(false)}
        onBack={() => setChecksOpen(false)}
      />
    );
  } else if (status === "inputs") {
    content = (
      <InputsStep
        projectId={project.id}
        runId={runId}
        epicText={detail.run.epicText}
        existingEpicKey={detail.run.existingEpicKey}
        documents={detail.documents}
        provider={provider}
        guidelines={files.filter((file) => file.kind === "guideline")}
        routing={files.filter((file) => file.kind === "routing")}
        busy={busy}
        onRunChecks={() => void runChecks()}
        onDocumentsChanged={reload}
      />
    );
  } else if (status === "checked" || status === "questions") {
    content = (
      <QuestionsStep
        runId={runId}
        status={status}
        questions={detail.questions}
        busy={busy}
        onResolved={resolveQuestion}
        onGenerateQuestions={() => void generateQuestions()}
        onGenerateDraft={() => void generateDraft()}
      />
    );
  } else {
    content = <ReviewScreen runId={runId} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Epic breakdown</h1>
          <p className="text-sm text-neutral-600">{project.name}</p>
        </div>
        <Stepper current={step} />
      </header>

      {failure ? (
        <div role="alert" className={`${errorText} flex flex-wrap items-center justify-between gap-3`}>
          <span>{failure.message}</span>
          <button type="button" className={secondaryButton} onClick={failure.retry} disabled={busy !== null}>
            Retry
          </button>
        </div>
      ) : null}

      {content}
    </div>
  );
}
