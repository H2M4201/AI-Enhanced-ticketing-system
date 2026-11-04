"use client";

import type { ReactNode } from "react";
import { AiTag, AssumptionTag, DecisionTag, KeyLink, TypeTag } from "@/components/review/Tags";
import {
  aiFilterIds,
  canChangeStructure,
  childKindOf,
  childrenByParent,
  needsRouting,
  validParentsFor,
} from "@/components/review/model";
import type { RunStatus } from "@/components/run/types";
import type { DraftItem } from "@/core/domain";

const ROW_BUTTON =
  "rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:text-neutral-400";

type Props = {
  items: DraftItem[];
  status: RunStatus;
  selectedId: string | null;
  aiOnly: boolean;
  siteUrl: string | null;
  onSelect: (id: string) => void;
  onSuggestion: (id: string, status: "accepted" | "rejected") => void;
  onAdd: (parentId: string, kind: "story" | "task") => void;
  onMove: (id: string) => void;
  onDelete: (id: string) => void;
  /** True after a failed save: every action is disabled until the draft is reloaded. */
  frozen?: boolean;
};

type RowProps = Omit<Props, "items" | "aiOnly" | "selectedId"> & {
  item: DraftItem;
  depth: number;
  /** True when an ancestor is a rejected suggestion. */
  greyed: boolean;
  selected: boolean;
  canMove: boolean;
};

function TreeRow({ item, depth, greyed, selected, canMove, frozen, status, siteUrl, onSelect, onSuggestion, onAdd, onMove, onDelete }: RowProps) {
  const rejected = item.suggestionStatus === "rejected";
  const dimmed = greyed || rejected;
  const structure = canChangeStructure(status);
  const child = childKindOf(item.kind);
  const isAi = item.origin === "ai_suggestion";

  return (
    <div
      data-testid={`row-${item.id}`}
      onClick={() => onSelect(item.id)}
      style={{ paddingLeft: `${8 + depth * 20}px` }}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded py-1 pr-2 text-sm ${
        selected ? "bg-blue-50 ring-1 ring-blue-300" : "hover:bg-neutral-100"
      } ${dimmed ? "text-neutral-400" : "text-neutral-900"}`}
    >
      <button
        type="button"
        className={`text-left ${dimmed ? "line-through" : "font-medium"}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(item.id);
        }}
      >
        {item.title}
      </button>
      <TypeTag kind={item.kind} />
      {isAi ? <AiTag /> : null}
      {item.assumption ? <AssumptionTag /> : null}
      {item.jiraKey === null && needsRouting(item) ? <DecisionTag /> : null}
      {item.jiraKey !== null ? <KeyLink siteUrl={siteUrl} jiraKey={item.jiraKey} /> : null}

      {isAi && item.suggestionStatus === "pending" && structure ? (
        <span className="flex gap-1">
          <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onSuggestion(item.id, "accepted")}>
            ✓ Accept
          </button>
          <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onSuggestion(item.id, "rejected")}>
            ✕ Reject
          </button>
        </span>
      ) : null}
      {isAi && rejected && !greyed && structure ? (
        <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onSuggestion(item.id, "accepted")}>
          Undo
        </button>
      ) : null}

      {structure && item.jiraKey === null && !dimmed && child ? (
        <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onAdd(item.id, child)} aria-label={`Add ${child} under ${item.title}`}>
          + {child === "story" ? "Story" : "Task"}
        </button>
      ) : null}
      {structure && item.jiraKey === null && !dimmed && item.kind !== "epic" && canMove ? (
        <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onMove(item.id)}>
          Move to…
        </button>
      ) : null}
      {structure && item.jiraKey === null && item.kind !== "epic" ? (
        <button type="button" className={ROW_BUTTON} disabled={frozen} onClick={() => onDelete(item.id)}>
          Delete
        </button>
      ) : null}

      {item.createError !== null ? <p className="w-full text-xs text-red-700">{item.createError}</p> : null}
    </div>
  );
}

/** The draft as an indented tree: each row shows its title, then its tags and actions. */
export function Tree({ items, status, selectedId, aiOnly, siteUrl, onSelect, onSuggestion, onAdd, onMove, onDelete, frozen = false }: Props) {
  const children = childrenByParent(items);
  const visible = aiFilterIds(items, aiOnly);
  const rows: ReactNode[] = [];

  function walk(parentId: string | null, depth: number, greyed: boolean) {
    for (const item of children.get(parentId) ?? []) {
      if (visible !== null && !visible.has(item.id)) continue;
      rows.push(
        <TreeRow
          key={item.id}
          item={item}
          depth={depth}
          greyed={greyed}
          selected={item.id === selectedId}
          canMove={validParentsFor(items, item).length > 0}
          frozen={frozen}
          status={status}
          siteUrl={siteUrl}
          onSelect={onSelect}
          onSuggestion={onSuggestion}
          onAdd={onAdd}
          onMove={onMove}
          onDelete={onDelete}
        />,
      );
      walk(item.id, depth + 1, greyed || item.suggestionStatus === "rejected");
    }
  }
  walk(null, 0, false);

  return <div className="flex flex-col gap-0.5" aria-label="Draft items">{rows}</div>;
}
