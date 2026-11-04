"use client";

import type { Blocker } from "@/core/blockers";

/** The blockers as a popover list. Each one selects the item it is about. */
export function BlockerList({ blockers, onPick }: { blockers: Blocker[]; onPick: (itemId: string) => void }) {
  return (
    <ul
      aria-label="Blockers"
      className="absolute right-0 z-10 mt-2 flex w-80 flex-col gap-1 rounded-md border border-neutral-200 bg-white p-2 shadow-lg"
    >
      {blockers.map((blocker) => (
        <li key={`${blocker.itemId}-${blocker.type}-${blocker.message}`}>
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-sm text-neutral-800 hover:bg-neutral-100"
            onClick={() => onPick(blocker.itemId)}
          >
            {blocker.message}
          </button>
        </li>
      ))}
    </ul>
  );
}
