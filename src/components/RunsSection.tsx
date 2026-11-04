import Link from "next/link";
import { card } from "@/components/styles";

/** A run as GET /api/projects/[id]/runs returns it. */
export type RunListEntry = {
  id: string;
  status: "inputs" | "checked" | "questions" | "review" | "creating" | "done";
  createdAt: string;
  createdByName: string;
  epicFirstLine: string;
};

const STATUS: Record<RunListEntry["status"], { label: string; tone: string }> = {
  inputs: { label: "Inputs", tone: "bg-neutral-100 text-neutral-800" },
  checked: { label: "Checked", tone: "bg-neutral-100 text-neutral-800" },
  questions: { label: "Questions", tone: "bg-blue-100 text-blue-900" },
  review: { label: "In review", tone: "bg-amber-100 text-amber-900" },
  creating: { label: "Creating", tone: "bg-amber-100 text-amber-900" },
  done: { label: "Done", tone: "bg-green-100 text-green-900" },
};

/** The project's breakdowns, newest first, each linking to its run page. */
export function RunsSection({ runs }: { runs: RunListEntry[] }) {
  return (
    <section className={`${card} flex flex-col gap-3`}>
      <h2 className="text-lg font-semibold">Breakdowns</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-neutral-600">No breakdowns yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200">
          {runs.map((run) => {
            const status = STATUS[run.status];
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
                <Link href={`/runs/${run.id}`} className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900 hover:underline">
                  {run.epicFirstLine || "(epic text removed by retention)"}
                </Link>
                <span className="text-xs text-neutral-600">
                  {`${run.createdByName} · ${new Date(run.createdAt).toLocaleString()}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
