"use client";

import { BlockerList } from "@/components/review/BlockerList";
import { ProviderBadge, type ProviderInfo } from "@/components/ProviderBadge";
import type { RunStatus } from "@/components/run/types";
import { primaryButton, secondaryButton } from "@/components/styles";
import type { Blocker } from "@/core/blockers";

type Props = {
  epicTitle: string;
  counts: { epics: number; stories: number; tasks: number };
  status: RunStatus;
  provider: ProviderInfo;
  /** Null when the epic has no Jira key yet. */
  epicUrl: string | null;
  canRegenerate: boolean;
  onRegenerate: () => void;
  aiOnly: boolean;
  onToggleAi: () => void;
  blockers: Blocker[];
  blockersOpen: boolean;
  onToggleBlockers: () => void;
  onPickBlocker: (itemId: string) => void;
  /** Tickets Create would make. */
  createCount: number;
  /** Failed items Retry would make. */
  retryCount: number;
  /** Seconds left before Retry is allowed after a failed create. Zero when it is allowed. */
  retryWaitSeconds: number;
  /** True while a save, a create or a regenerate is pending, or the draft needs reloading. The run-level actions wait. */
  busy: boolean;
  onCreate: () => void;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The header of the review: the epic, its counts, the run-level actions and the blocker count. */
export function TopBar(props: Props) {
  const { epicTitle, counts, status, provider, epicUrl, blockers, blockersOpen } = props;
  const blocked = blockers.length > 0;
  const primaryDisabled =
    props.busy ||
    (status === "review"
      ? blocked || props.createCount === 0
      : status === "creating"
        ? blocked || props.retryCount === 0 || props.retryWaitSeconds > 0
        : true);

  return (
    <header className="flex flex-col gap-3 border-b border-neutral-200 pb-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">{epicTitle}</h2>
        <p className="text-sm text-neutral-600">
          {`${plural(counts.epics, "epic")} · ${plural(counts.stories, "story")} · ${plural(counts.tasks, "task")}`}
        </p>
        <ProviderBadge provider={provider} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {props.canRegenerate ? (
          <button type="button" className={secondaryButton} onClick={props.onRegenerate} disabled={props.busy}>
            Regenerate
          </button>
        ) : null}
        <button type="button" className={secondaryButton} aria-pressed={props.aiOnly} onClick={props.onToggleAi}>
          Filter: AI suggestions
        </button>

        <div className="relative ml-auto flex items-center gap-2">
          {blocked && status !== "done" ? (
            <div className="relative">
              <button
                type="button"
                className={secondaryButton}
                aria-expanded={blockersOpen}
                onClick={props.onToggleBlockers}
              >
                {plural(blockers.length, "blocker")}
              </button>
              {blockersOpen ? <BlockerList blockers={blockers} onPick={props.onPickBlocker} /> : null}
            </div>
          ) : null}

          {status === "review" ? (
            <button type="button" className={primaryButton} onClick={props.onCreate} disabled={primaryDisabled}>
              {`Create ${props.createCount} tickets in Jira`}
            </button>
          ) : null}

          {status === "creating" ? (
            <>
              {props.retryWaitSeconds > 0 ? (
                <span className="text-xs text-neutral-600">{`Retry available in ${props.retryWaitSeconds}s`}</span>
              ) : null}
              <button type="button" className={primaryButton} onClick={props.onCreate} disabled={primaryDisabled}>
                {`Retry failed (${props.retryCount})`}
              </button>
            </>
          ) : null}

          {status === "done" ? (
            <>
              <span className="text-sm font-medium text-green-800">All tickets are in Jira</span>
              {epicUrl !== null ? (
                <a href={epicUrl} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
                  View epic in Jira
                </a>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
