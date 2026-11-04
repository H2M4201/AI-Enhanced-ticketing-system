"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/run/Spinner";
import type { QuestionView, RunStatus } from "@/components/run/types";
import { card, errorText, inputClass, label, primaryButton, secondaryButton } from "@/components/styles";
import type { Resolution } from "@/core/domain";
import { apiFetch, errorMessage } from "@/lib/api";

/** How long the Answer box waits after the last keystroke before it saves. */
const ANSWER_DEBOUNCE_MS = 600;

type Props = {
  runId: string;
  status: RunStatus;
  questions: QuestionView[];
  /** What is running now, such as "Generating questions…". Null when idle. */
  busy: string | null;
  /** Null means the question is unresolved again (its Answer was cleared). */
  onResolved: (questionId: string, resolution: Resolution | null) => void;
  onGenerateQuestions: () => void;
  onGenerateDraft: () => void;
  onBackToInputs: () => void;
  onRerunChecks: () => void;
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
  onResolved: (questionId: string, resolution: Resolution | null) => void;
  onDirtyChange: (questionId: string, dirty: boolean) => void;
};

/**
 * One question: its text and sources, the Answer box and the two other choices.
 * Saves for one question run one after another, so the last thing the user did is the last thing written.
 */
function QuestionCard({ runId, question, onResolved, onDirtyChange }: CardProps) {
  const savedAnswer = question.resolution?.kind === "answered" ? question.resolution.answer : "";
  const [text, setText] = useState(savedAnswer);
  const [timerPending, setTimerPending] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(savedAnswer);
  /** The answer the server holds, or "" when it holds a choice or nothing. Updated only inside queued work. */
  const savedRef = useRef(savedAnswer);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ runId, question, onResolved });

  useEffect(() => {
    latest.current = { runId, question, onResolved };
  });

  const dirty = timerPending || inFlight > 0;
  useEffect(() => {
    onDirtyChange(question.id, dirty);
  }, [question.id, dirty, onDirtyChange]);

  useEffect(() => {
    const id = question.id;
    return () => onDirtyChange(id, false);
  }, [question.id, onDirtyChange]);

  /** Queues work behind any save already running for this question. */
  const enqueue = useCallback((work: () => Promise<void>) => {
    setInFlight((count) => count + 1);
    chain.current = chain.current.then(async () => {
      try {
        await work();
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setInFlight((count) => count - 1);
      }
    });
  }, []);

  const saveChoice = useCallback(
    (resolution: Resolution) => {
      enqueue(async () => {
        const { runId: run, question: current, onResolved: report } = latest.current;
        await saveResolution(run, current.id, resolution);
        savedRef.current = "";
        report(current.id, resolution);
      });
    },
    [enqueue],
  );

  /** Saves the typed answer. A cleared answer is never sent: it makes the question unresolved here instead. */
  const saveAnswer = useCallback(
    (value: string) => {
      const answer = value.trim();
      enqueue(async () => {
        const { runId: run, question: current, onResolved: report } = latest.current;
        if (answer === "") {
          if (savedRef.current === "") return;
          savedRef.current = "";
          report(current.id, null);
          return;
        }
        if (answer === savedRef.current) return;
        await saveResolution(run, current.id, { kind: "answered", answer });
        savedRef.current = answer;
        report(current.id, { kind: "answered", answer });
      });
    },
    [enqueue],
  );

  const cancelPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTimerPending(false);
  }, []);

  // A pending answer is saved when the card goes away, so typing is never lost.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
      saveAnswer(textRef.current);
    },
    [saveAnswer],
  );

  function changeAnswer(value: string) {
    setText(value);
    textRef.current = value;
    if (timer.current) clearTimeout(timer.current);
    setTimerPending(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setTimerPending(false);
      saveAnswer(textRef.current);
    }, ANSWER_DEBOUNCE_MS);
  }

  function blurAnswer() {
    // Only text typed since the last save is sent. A choice made later keeps the text box as it is but is not overwritten.
    if (timer.current === null) return;
    cancelPending();
    saveAnswer(textRef.current);
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
            saveChoice({ kind: "out_of_scope" });
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
            saveChoice({ kind: "judgment" });
          }}
        >
          Use your judgment
        </button>
        {inFlight > 0 ? <Spinner label="Saving…" /> : null}
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
  onBackToInputs,
  onRerunChecks,
}: Props) {
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback(
    (questionId: string, value: boolean) =>
      setDirty((current) => (current[questionId] === value ? current : { ...current, [questionId]: value })),
    [],
  );
  const anySaving = Object.values(dirty).some(Boolean);
  const answered = status === "questions";
  const allResolved = questions.every((question) => question.resolution !== null);
  const canGenerateDraft = answered && allResolved && !anySaving && busy === null;

  return (
    <div className="flex flex-col gap-6">
      {status === "checked" ? (
        <div className={`${card} flex flex-col gap-3`}>
          <p className="text-sm text-neutral-700">The checks passed. Generate the clarifying questions for this epic.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={onGenerateQuestions} disabled={busy !== null}>
              Generate questions
            </button>
            <button type="button" className={secondaryButton} onClick={onBackToInputs} disabled={busy !== null}>
              Back to inputs
            </button>
            <button type="button" className={secondaryButton} onClick={onRerunChecks} disabled={busy !== null}>
              Re-run checks
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
            <QuestionCard
              key={question.id}
              runId={runId}
              question={question}
              onResolved={onResolved}
              onDirtyChange={onDirtyChange}
            />
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
        {anySaving ? <Spinner label="Saving…" /> : null}
        {busy ? <Spinner label={busy} /> : null}
      </div>
    </div>
  );
}
