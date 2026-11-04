"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AiTag, AssumptionTag, DecisionTag, KeyLink, TypeTag } from "@/components/review/Tags";
import { canEditItem, needsRouting } from "@/components/review/model";
import type { RunStatus } from "@/components/run/types";
import { errorText, inputClass, label, secondaryButton } from "@/components/styles";
import type { DraftItem, ItemKind } from "@/core/domain";
import type { AssignableUser } from "@/core/ticketing/adapter";

/** Text typed in the panel waits this long after the last keystroke before it is saved. Blur and unmount save at once. */
export const TEXT_DEBOUNCE_MS = 500;

export type ItemPatch = Partial<Pick<DraftItem, "title" | "description" | "acceptanceCriteria" | "estimate" | "fieldValues">>;

type RequiredFields = Record<ItemKind, { key: string; name: string }[]>;

type Props = {
  item: DraftItem;
  status: RunStatus;
  siteUrl: string | null;
  requiredFields: RequiredFields;
  assignableUsers: AssignableUser[];
  onSave: (id: string, patch: ItemPatch) => void;
  onRoute: (id: string, accountId: string) => void;
  /** True while typed changes wait to be saved, so the screen can hold its controls. */
  onPendingChange: (pending: boolean) => void;
  /** True after a failed save: the fields are read-only until the draft is reloaded. */
  frozen?: boolean;
};

/** What the inputs show. Estimate and required fields are text until they are saved. */
type Draft = {
  title: string;
  description: string;
  criteria: string[];
  estimate: string;
  fields: Record<string, string>;
};

function valueText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function draftOf(item: DraftItem, required: { key: string }[]): Draft {
  return {
    title: item.title,
    description: item.description,
    criteria: [...item.acceptanceCriteria],
    estimate: item.estimate === null ? "" : String(item.estimate),
    fields: Object.fromEntries(required.map((field) => [field.key, valueText(item.fieldValues[field.key])])),
  };
}

/** The patch a draft stands for. A blank title is not sent, since Jira needs one. */
function patchOf(draft: Draft, item: DraftItem, required: { key: string }[]): ItemPatch {
  const fieldValues: Record<string, unknown> = { ...item.fieldValues };
  for (const field of required) {
    const text = draft.fields[field.key] ?? "";
    fieldValues[field.key] = text.trim() === "" ? null : text;
  }
  const estimate = draft.estimate.trim() === "" ? null : Number(draft.estimate);
  return {
    ...(draft.title.trim() === "" ? {} : { title: draft.title }),
    description: draft.description,
    acceptanceCriteria: draft.criteria.map((line) => line.trim()).filter((line) => line !== ""),
    estimate: estimate !== null && Number.isFinite(estimate) ? estimate : null,
    fieldValues,
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The selected item's fields and routing. Text edits are saved 500 ms after the last keystroke,
 * and at once on blur or when the panel closes. The panel is keyed by item, so each item keeps its own draft.
 */
export function DetailPanel({
  item,
  status,
  siteUrl,
  requiredFields,
  assignableUsers,
  onSave,
  onRoute,
  onPendingChange,
  frozen = false,
}: Props) {
  const required = requiredFields[item.kind];
  const editable = canEditItem(status, item) && !frozen;
  const [draft, setDraft] = useState(() => draftOf(item, required));
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ item, required, onSave, onPendingChange });

  useEffect(() => {
    latest.current = { item, required, onSave, onPendingChange };
  });

  /** Saves the pending draft, if there is one. Reads only refs, so every caller sees the latest values. */
  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const { item: current, required: fields, onSave: save, onPendingChange: report } = latest.current;
    save(current.id, patchOf(draftRef.current, current, fields));
    report(false);
  }, []);

  // A typed change is saved when the panel goes away, so nothing typed is lost.
  useEffect(() => () => flush(), [flush]);

  function change(next: Draft) {
    if (!editable) return;
    draftRef.current = next;
    setDraft(next);
    dirty.current = true;
    latest.current.onPendingChange(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, TEXT_DEBOUNCE_MS);
  }

  function update(changes: Partial<Draft>) {
    change({ ...draftRef.current, ...changes });
  }

  const routing = item.routing;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TypeTag kind={item.kind} />
          {item.origin === "ai_suggestion" ? <AiTag /> : null}
          {item.assumption ? <AssumptionTag /> : null}
          {item.jiraKey === null && needsRouting(item) ? <DecisionTag /> : null}
          {item.jiraKey !== null ? <KeyLink siteUrl={siteUrl} jiraKey={item.jiraKey} /> : null}
        </div>
        {item.createError !== null ? <p className={errorText}>{item.createError}</p> : null}
        {!editable ? (
          <p className="text-xs text-neutral-500">
            {frozen
              ? "Editing is paused until the draft is reloaded."
              : item.jiraKey !== null
                ? "This item exists in Jira, so it is read-only here."
                : "Read-only at this stage."}
          </p>
        ) : null}
      </header>

      <Section title="Details">
        <div>
          <label htmlFor={`title-${item.id}`} className={label}>
            Title
          </label>
          <input
            id={`title-${item.id}`}
            className={inputClass}
            value={draft.title}
            disabled={!editable}
            onChange={(event) => update({ title: event.target.value })}
            onBlur={() => {
              // A blank title is never sent, so the field goes back to the saved title before the save.
              if (draftRef.current.title.trim() === "") update({ title: latest.current.item.title });
              flush();
            }}
          />
        </div>
        <div>
          <label htmlFor={`description-${item.id}`} className={label}>
            Description
          </label>
          <textarea
            id={`description-${item.id}`}
            className={inputClass}
            rows={4}
            value={draft.description}
            disabled={!editable}
            onChange={(event) => update({ description: event.target.value })}
            onBlur={flush}
          />
        </div>
        <div>
          <p className={label}>Acceptance criteria</p>
          <ul className="flex flex-col gap-2">
            {draft.criteria.map((criterion, index) => (
              <li key={index} className="flex gap-2">
                <input
                  aria-label={`Acceptance criterion ${index + 1}`}
                  className={inputClass}
                  value={criterion}
                  disabled={!editable}
                  onChange={(event) =>
                    update({ criteria: draft.criteria.map((line, at) => (at === index ? event.target.value : line)) })
                  }
                  onBlur={flush}
                />
                {editable ? (
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={`Remove acceptance criterion ${index + 1}`}
                    onClick={() => {
                      update({ criteria: draft.criteria.filter((_, at) => at !== index) });
                      flush();
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {editable ? (
            <button type="button" className={`${secondaryButton} mt-2`} onClick={() => update({ criteria: [...draft.criteria, ""] })}>
              Add criterion
            </button>
          ) : null}
        </div>
        <div>
          <label htmlFor={`estimate-${item.id}`} className={label}>
            Estimate
          </label>
          <input
            id={`estimate-${item.id}`}
            type="number"
            min={0}
            className={inputClass}
            value={draft.estimate}
            disabled={!editable}
            onChange={(event) => update({ estimate: event.target.value })}
            onBlur={flush}
          />
        </div>
        {required.map((field) => (
          <div key={field.key}>
            <label htmlFor={`field-${item.id}-${field.key}`} className={label}>
              {field.name}
            </label>
            <input
              id={`field-${item.id}-${field.key}`}
              className={inputClass}
              value={draft.fields[field.key] ?? ""}
              disabled={!editable}
              onChange={(event) => update({ fields: { ...draft.fields, [field.key]: event.target.value } })}
              onBlur={flush}
            />
          </div>
        ))}
      </Section>

      {item.kind !== "epic" ? (
        <Section title="Routing">
          {routing ? (
            <div className="rounded-md border border-neutral-200 p-3 text-sm text-neutral-800">
              <p className="font-medium">
                {routing.displayName ? `👤 ${routing.displayName}` : "Unassigned"}
                {routing.teamName ? ` · ${routing.teamName}` : ""}
              </p>
              <p className="text-xs text-neutral-500">{routing.reason}</p>
              {routing.ruleQuote ? (
                <p className="text-xs text-neutral-500">
                  Rule: &ldquo;{routing.ruleQuote}&rdquo;
                  {routing.ruleLine !== null ? ` (routing.md line ${routing.ruleLine})` : ""}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-neutral-600">No routing yet.</p>
          )}
          <div>
            <label htmlFor={`assignee-${item.id}`} className={label}>
              Change assignee
            </label>
            <select
              id={`assignee-${item.id}`}
              className={inputClass}
              value={routing?.accountId ?? ""}
              disabled={!editable}
              onChange={(event) => onRoute(item.id, event.target.value)}
            >
              <option value="" disabled>
                Choose a person
              </option>
              {assignableUsers.map((user) => (
                <option key={user.accountId} value={user.accountId}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </div>
        </Section>
      ) : null}

      {item.shapedBy.length > 0 ? <p className="text-xs text-neutral-500">Shaped by: {item.shapedBy.join(", ")}</p> : null}
      {item.sourceRefs.length > 0 ? (
        <Section title="Sources">
          <ul className="text-xs text-neutral-600">
            {item.sourceRefs.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
