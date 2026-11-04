"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPanel, type ItemPatch } from "@/components/review/DetailPanel";
import {
  canRegenerate,
  countKinds,
  aiFilterIds,
  descendantIds,
  keyUrl,
  uncreated,
  validParentsFor,
} from "@/components/review/model";
import { Tree } from "@/components/review/Tree";
import { TopBar } from "@/components/review/TopBar";
import { Spinner } from "@/components/run/Spinner";
import { errorText, primaryButton, secondaryButton } from "@/components/styles";
import type { DraftItem } from "@/core/domain";
import type { CreateSummary } from "@/core/pipeline/create";
import { ApiError, apiFetch, errorMessage } from "@/lib/api";
import type { DraftOp } from "@/server/runs/ops";
import type { DraftState, ReviewView } from "@/server/runs/service";

/** Retry stays disabled this long after a failed create: Jira search is eventually consistent, and an early retry can duplicate issues. */
const RETRY_WAIT_MS = 10_000;

const REGENERATE_CONFIRM =
  "Regenerate replaces the whole draft. Your edits, Accept/Reject decisions and routing changes will be lost. Clarification answers are kept.";

const PANEL = "rounded-lg border border-neutral-200 bg-white p-4 shadow-sm";

/** A failed call. A failed save is unsaved: the edit did not reach the draft, so the screen must reload. */
type Failure = { message: string; reload: boolean; unsaved: boolean };

type Confirm =
  | { kind: "regenerate" }
  | { kind: "delete"; item: DraftItem; childCount: number }
  | { kind: "move"; item: DraftItem }
  | null;

type Props = {
  runId: string;
  /** The Jira site URL of the project, used for the key links. */
  siteUrl: string | null;
  /** Called after a create, so the run page can refresh the step it shows. */
  onRunChanged: () => void;
};

/**
 * The review of the AI-drafted epic, stories and tasks. Edits go to the server one at a time, in order,
 * each with the draft version the previous response returned. A failed save stops the queue until the
 * draft is reloaded, so a stale edit is never sent again.
 */
export function ReviewScreen({ runId, siteUrl, onRunChanged }: Props) {
  const [review, setReview] = useState<ReviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Changes when the screen starts again from the server, so the detail panel reloads its fields. */
  const [epoch, setEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiOnly, setAiOnly] = useState(false);
  const [blockersOpen, setBlockersOpen] = useState(false);
  const [textPending, setTextPending] = useState(false);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  /** Seconds left before Retry is allowed after a failed create. Zero when it is allowed. */
  const [retryWait, setRetryWait] = useState(0);

  const versionRef = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** Set by a failed save. Queued saves are dropped until a reload clears it. */
  const blocked = useRef(false);
  /** Set while a create runs, so a second click cannot send a second create. */
  const creating = useRef(false);

  /** Takes a review from the server. The selection is kept only while its item still exists. */
  const adopt = useCallback((next: ReviewView) => {
    versionRef.current = next.draftVersion;
    setReview(next);
    setSelectedId((current) => (current !== null && next.items.some((item) => item.id === current) ? current : null));
  }, []);

  /** Takes the draft state an edit returns. The rest of the review (provider, epic, required fields) is unchanged. */
  const merge = useCallback((next: DraftState) => {
    versionRef.current = next.draftVersion;
    setReview((current) => (current === null ? current : { ...current, ...next }));
    setSelectedId((current) => (current !== null && next.items.some((item) => item.id === current) ? current : null));
  }, []);

  /** A review that replaces what is shown (load, regenerate, reload). The detail panel starts again from it. */
  const adoptFresh = useCallback(
    (next: ReviewView) => {
      adopt(next);
      setEpoch((value) => value + 1);
    },
    [adopt],
  );

  /** Runs work after the work already queued. Each job starts once the previous one has settled. */
  const queue = useCallback((work: () => Promise<void>) => {
    const next = chain.current.then(work);
    chain.current = next.catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    apiFetch<ReviewView>(`/api/runs/${runId}/draft`).then(
      (next) => {
        if (live) adoptFresh(next);
      },
      (error: unknown) => {
        if (live) setLoadError(errorMessage(error));
      },
    );
    return () => {
      live = false;
    };
  }, [runId, adoptFresh]);

  const waiting = retryWait > 0;
  useEffect(() => {
    if (!waiting) return;
    const timerId = setInterval(() => setRetryWait((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timerId);
  }, [waiting]);

  /** Fetches the draft again, after the queue has settled. Clears a conflict once the screen shows the server's state. */
  const reloadReview = useCallback(
    () =>
      queue(async () => {
        try {
          const next = await apiFetch<ReviewView>(`/api/runs/${runId}/draft`);
          blocked.current = false;
          setFailure((current) => (current?.reload ? null : current));
          adoptFresh(next);
        } catch (error) {
          setFailure({ message: errorMessage(error), reload: true, unsaved: false });
        }
      }),
    [queue, runId, adoptFresh],
  );

  /** Sends one edit. It starts after earlier edits and uses the version they returned. A failure stops the queue. */
  const save = useCallback(
    (op: DraftOp) => {
      if (blocked.current) return;
      // Only a failed save is cleared by a new edit. A create failure stays until a reload.
      setFailure((current) => (current?.unsaved ? null : current));
      setPendingSaves((count) => count + 1);
      void queue(async () => {
        try {
          if (blocked.current) return;
          const next = await apiFetch<DraftState>(`/api/runs/${runId}/draft`, {
            method: "PATCH",
            body: JSON.stringify({ op, expectedVersion: versionRef.current }),
          });
          merge(next);
        } catch (error) {
          blocked.current = true;
          setFailure({ message: errorMessage(error), reload: true, unsaved: true });
        } finally {
          setPendingSaves((count) => count - 1);
        }
      });
    },
    [queue, runId, merge],
  );

  const onSave = useCallback((id: string, patch: ItemPatch) => save({ type: "update", id, patch }), [save]);
  const onRoute = useCallback((id: string, accountId: string) => save({ type: "route", id, accountId }), [save]);
  const onSuggestion = useCallback(
    (id: string, status: "accepted" | "rejected") => save({ type: "suggestion", id, status }),
    [save],
  );
  const onAdd = useCallback(
    (parentId: string, kind: "story" | "task") =>
      save({ type: "add", parentId, kind, title: kind === "story" ? "New story" : "New task" }),
    [save],
  );

  function startRetryWait() {
    setRetryWait(RETRY_WAIT_MS / 1000);
  }

  async function createTickets() {
    if (creating.current) return;
    creating.current = true;
    setBusyLabel("Creating tickets in Jira…");
    setFailure(null);
    try {
      const summary = await apiFetch<CreateSummary>(`/api/runs/${runId}/create`, { method: "POST" });
      if (summary.failed > 0) startRetryWait();
      await reloadReview();
    } catch (error) {
      startRetryWait();
      const conflict = error instanceof ApiError && error.code === "run_state";
      setFailure({ message: errorMessage(error), reload: conflict, unsaved: false });
      if (!conflict) await reloadReview();
    } finally {
      creating.current = false;
      setBusyLabel(null);
      onRunChanged();
    }
  }

  async function regenerate() {
    setConfirm(null);
    setBusyLabel("Regenerating the draft…");
    setFailure(null);
    try {
      const next = await apiFetch<ReviewView>(`/api/runs/${runId}/draft`, { method: "POST" });
      blocked.current = false;
      adoptFresh(next);
    } catch (error) {
      setFailure({
        message: errorMessage(error),
        reload: error instanceof ApiError && error.code === "run_state",
        unsaved: false,
      });
    } finally {
      setBusyLabel(null);
    }
  }

  function deleteItem(item: DraftItem) {
    setConfirm(null);
    if (selectedId === item.id) setSelectedId(null);
    save({ type: "delete", id: item.id });
  }

  function moveItem(item: DraftItem, newParentId: string) {
    setConfirm(null);
    save({ type: "move", id: item.id, newParentId });
  }

  if (loadError !== null) {
    return (
      <p role="alert" className={errorText}>
        {loadError}
      </p>
    );
  }
  if (review === null) return <p className="text-sm text-neutral-600">Loading the draft…</p>;

  const { items, status } = review;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const epic = items.find((item) => item.kind === "epic") ?? null;
  // An existing epic is appended to, not created, so it is not counted among the new tickets.
  const toCreate = uncreated(items).filter((item) => review.existingEpic === null || item.kind !== "epic");
  /** After a failed save the draft is stale: nothing may be edited until a reload. */
  const frozen = failure?.reload === true;
  /** Saves, creates and regenerates hold the controls: a pending save must not race a create. */
  const locked = busyLabel !== null || pendingSaves > 0 || textPending || frozen;
  const childTickets = toCreate.filter((item) => item.kind !== "epic").length;

  function askDelete(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) setConfirm({ kind: "delete", item, childCount: descendantIds(items, id).size });
  }

  function askMove(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) setConfirm({ kind: "move", item });
  }

  return (
    <div className="flex flex-col gap-4">
      <TopBar
        epicTitle={epic?.title ?? ""}
        counts={countKinds(items)}
        status={status}
        provider={review.provider}
        epicUrl={epic?.jiraKey ? keyUrl(siteUrl, epic.jiraKey) : null}
        canRegenerate={canRegenerate(status, items)}
        onRegenerate={() => setConfirm({ kind: "regenerate" })}
        aiOnly={aiOnly}
        onToggleAi={() => setAiOnly((value) => !value)}
        blockers={review.blockers}
        blockersOpen={blockersOpen}
        onToggleBlockers={() => setBlockersOpen((value) => !value)}
        onPickBlocker={(itemId) => {
          // An item the AI filter hides would not show as selected, so the filter goes off first.
          const shown = aiFilterIds(items, aiOnly);
          if (shown !== null && !shown.has(itemId)) setAiOnly(false);
          setSelectedId(itemId);
          setBlockersOpen(false);
        }}
        createCount={toCreate.length}
        retryCount={toCreate.length}
        retryWaitSeconds={retryWait}
        busy={locked}
        onCreate={() => void createTickets()}
      />

      {failure !== null ? (
        <div role="alert" className={`${errorText} sticky top-0 z-10 flex flex-col gap-2 shadow-sm`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{failure.message}</span>
            {failure.reload ? (
              <button type="button" className={secondaryButton} onClick={() => void reloadReview()}>
                Reload
              </button>
            ) : null}
          </div>
          {failure.unsaved ? <p>Your latest changes were not saved. Reload to continue.</p> : null}
        </div>
      ) : null}

      {busyLabel !== null ? <Spinner label={busyLabel} /> : null}

      {review.existingEpic !== null ? (
        <div className={`${PANEL} flex flex-col gap-2 text-sm text-neutral-800`}>
          <p className="font-medium">
            {`Will append to ${review.existingEpic.key}${review.existingEpic.summary ? ` ${review.existingEpic.summary}` : ""}:`}
          </p>
          {review.clarificationsPreview !== "" ? (
            <pre className="whitespace-pre-wrap rounded bg-neutral-50 p-3 font-sans text-sm text-neutral-800">
              {review.clarificationsPreview}
            </pre>
          ) : null}
          <p>{`and add ${childTickets} child tickets. Existing text and children are not changed.`}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <section aria-label="Draft tree" className={`${PANEL} w-full md:w-[45%] md:shrink-0`}>
          <Tree
            items={items}
            status={status}
            selectedId={selectedId}
            aiOnly={aiOnly}
            siteUrl={siteUrl}
            onSelect={setSelectedId}
            onSuggestion={onSuggestion}
            onAdd={onAdd}
            onMove={askMove}
            onDelete={askDelete}
            frozen={frozen}
          />
        </section>

        <section aria-label="Item details" className={`${PANEL} w-full min-w-0 flex-1`}>
          {selected !== null ? (
            <DetailPanel
              key={`${selected.id}-${epoch}`}
              item={selected}
              status={status}
              siteUrl={siteUrl}
              requiredFields={review.requiredFields}
              assignableUsers={review.assignableUsers}
              onSave={onSave}
              onRoute={onRoute}
              onPendingChange={setTextPending}
              frozen={frozen}
            />
          ) : (
            <p className="text-sm text-neutral-600">Select an item in the tree to see and edit it.</p>
          )}
        </section>
      </div>

      {confirm?.kind === "regenerate" ? (
        <ConfirmDialog
          title="Regenerate the draft?"
          message={REGENERATE_CONFIRM}
          confirmLabel="Regenerate"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void regenerate()}
        />
      ) : null}
      {confirm?.kind === "delete" ? (
        <ConfirmDialog
          title="Delete this item?"
          message={`Delete "${confirm.item.title}"${
            confirm.childCount > 0 ? ` and its ${confirm.childCount} child item${confirm.childCount === 1 ? "" : "s"}` : ""
          }?`}
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteItem(confirm.item)}
        />
      ) : null}
      {confirm?.kind === "move" ? (
        <MoveDialog
          item={confirm.item}
          parents={validParentsFor(items, confirm.item)}
          onCancel={() => setConfirm(null)}
          onPick={(parentId) => moveItem(confirm.item, parentId)}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className={`${PANEL} w-full max-w-md`}>
        <h2 id="confirm-title" className="text-base font-semibold text-neutral-900">
          {title}
        </h2>
        <p className="mt-2 text-sm text-neutral-700">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={primaryButton} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Lists the parents an item may move under. Only valid parents are offered. */
function MoveDialog({
  item,
  parents,
  onCancel,
  onPick,
}: {
  item: DraftItem;
  parents: DraftItem[];
  onCancel: () => void;
  onPick: (parentId: string) => void;
}) {
  const noun = item.kind === "task" ? "story" : "epic";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="move-title" className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className={`${PANEL} w-full max-w-md`}>
        <h2 id="move-title" className="text-base font-semibold text-neutral-900">
          {`Move "${item.title}" to…`}
        </h2>
        {parents.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-700">{`There is no ${noun} it can move under.`}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1">
            {parents.map((parent) => (
              <li key={parent.id}>
                <button
                  type="button"
                  className="w-full rounded px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100"
                  onClick={() => onPick(parent.id)}
                >
                  {parent.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
