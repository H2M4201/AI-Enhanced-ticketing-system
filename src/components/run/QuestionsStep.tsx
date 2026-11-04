"use client";

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/run/Spinner";
import type { QuestionView, RunStatus } from "@/components/run/types";
import { card, errorText, inputClass, label, primaryButton, secondaryButton } from "@/components/styles";
import { apiFetch, errorMessage } from "@/lib/api";
import type { Resolution } from "@/core/domain";

/** How long the Answer box waits after the last keystroke before it saves. */
const ANSWER_DEBOUNCE_MS = 600;

type Props = {
  runId: string;
  status: RunStatus;
  questions: QuestionView[];
  /** What is running now, such as "Generating questions…". Null when idle. */
  busy: string | null;
  onResolved: (questionId: string, resolution: Resolution) => void;
  onGenerateQuestions: () => void;
  onGenerateDraft: () => void;
};

async function saveResolution(runId: string, questionId: string, resolution: Resolution): Promise<void> {
  await apiFetch(`/api/runs/${runId}/questions/${encodeURIComponent(questionId)}`, {
    method: "PUT",
    body: JSON.stringify(resolution),
  });
}

type CardProps = {
  runId: string;
  question: QuestionView;
  onResolved: (questionId: string, resolution: Resolution) => void;
};

/** One question: its text and sources, the Answer box and the two other choices. Each choice saves as it changes. */
function QuestionCard({ runId, question, onResolved }: CardProps) {
  const savedAnswer = question.resolution?.kind === "answered" ? question.resolution.answer : "";
  const [text, setText] = useState(savedAnswer);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSaved = useRef(savedAnswer);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function save(resolution: Resolution) {
    setSaving(true);
    setError(null);
    try {
      await saveResolution(runId, question.id, resolution);
      if (resolution.kind === "answered") lastSaved.current = resolution.answer;
      onResolved(question.id, resolution);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function cancelPending() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  /** Saves the typed answer when it is not empty and differs from what was last saved. */
  function saveAnswer(value: string) {
    const answer = value.trim();
    if (answer === "" || answer === lastSaved.current) return;
    void save({ kind: "answered", answer });
  }

  function changeAnswer(value: string) {
    setText(value);
    cancelPending();
    timer.current = setTimeout(() => {
      timer.current = null;
      saveAnswer(value);
    }, ANSWER_DEBOUNCE_MS);
  }

  function blurAnswer() {
    cancelPending();
    saveAnswer(text);
  }

  const kind = question.resolution?.kind;

  return (
    <li className={`${card} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-700">
          {question.category}
        </span>
        <span className="text-xs text-neutral-500">#{question.rank}</span>
      </div>
      <p className="text-sm font-medium text-neutral-900">{question.text}</p>
      {question.sourceRefs.length > 0 ? (
        <p className="text-xs text-neutral-500">Source: {question.sourceRefs.join(", ")}</p>
      ) : null}

      {error ? (
        <p role="alert" className={errorText}>
          {error}
        </p>
      ) : null}

      <div>
        <label htmlFor={`answer-${question.id}`} className={label}>
          Answer
        </label>
        <textarea
          id={`answer-${question.id}`}
          className={inputClass}
          rows={2}
          value={text}
          onChange={(e) => changeAnswer(e.target.value)}
          onBlur={blurAnswer}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={secondaryButton}
          aria-pressed={kind === "out_of_scope"}
          onClick={() => {
            cancelPending();
            void save({ kind: "out_of_scope" });
          }}
        >
          Out of scope
        </button>
        <button
          type="button"
          className={secondaryButton}
          aria-pressed={kind === "judgment"}
          onClick={() => {
            cancelPending();
            void save({ kind: "judgment" });
          }}
        >
          Use your judgment
        </button>
        {saving ? <Spinner label="Saving…" /> : null}
      </div>
    </li>
  );
}

/** The clarifying questions. Each one needs a resolution before the draft can be generated. */
export function QuestionsStep({
  runId,
  status,
  questions,
  busy,
  onResolved,
  onGenerateQuestions,
  onGenerateDraft,
}: Props) {
  const answered = status === "questions";
  const allResolved = questions.every((question) => question.resolution !== null);
  const canGenerateDraft = answered && allResolved && busy === null;

  return (
    <div className="flex flex-col gap-6">
      {status === "checked" ? (
        <div className={`${card} flex flex-col gap-3`}>
          <p className="text-sm text-neutral-700">The checks passed. Generate the clarifying questions for this epic.</p>
          <div>
            <button type="button" className={primaryButton} onClick={onGenerateQuestions} disabled={busy !== null}>
              Generate questions
            </button>
          </div>
        </div>
      ) : null}

      {answered && questions.length === 0 ? (
        <p className="text-sm text-neutral-700">No open questions found</p>
      ) : null}

      {questions.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {questions.map((question) => (
            <QuestionCard key={question.id} runId={runId} question={question} onResolved={onResolved} />
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButton} onClick={onGenerateDraft} disabled={!canGenerateDraft}>
          Generate draft
        </button>
        {answered && !allResolved ? (
          <p className="text-sm text-neutral-600">Answer, mark out of scope, or use your judgment for every question to continue.</p>
        ) : null}
        {busy ? <Spinner label={busy} /> : null}
      </div>
    </div>
  );
}
