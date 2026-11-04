import Link from "next/link";
import { Spinner } from "@/components/run/Spinner";
import { card, primaryButton, secondaryButton } from "@/components/styles";
import type { ChecksResult } from "@/server/runs/service";

type Props = {
  projectId: string;
  checks: ChecksResult;
  /** What is running now, such as "Running checks…". Null when idle. */
  busy: string | null;
  onRerun: () => void;
  onContinue: () => void;
  onBack: () => void;
};

const ERROR_BOX = "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800";
const WARNING_BOX = "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900";
const TABLE = "w-full border-collapse text-left text-sm";
const CELL = "border-t border-neutral-200 px-2 py-1.5 align-top";
const HEAD = "bg-neutral-100 px-2 py-1.5 font-medium text-neutral-700";

function list(items: string[], className: string) {
  return (
    <ul className={`${className} flex flex-col gap-1`}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** The results of the checks: budget, structure, the routing roster and the existing epic. Any error blocks Continue. */
export function ChecksStep({ projectId, checks, busy, onRerun, onContinue, onBack }: Props) {
  const { budget, structure, roster } = checks;
  const blocked = !checks.ok || roster.unresolved.length > 0;
  const projectHref = `/projects/${projectId}`;

  return (
    <div className="flex flex-col gap-6">
      <section className={`${card} flex flex-col gap-3`}>
        <h2 className="text-lg font-semibold">Context budget</h2>
        <p className="text-sm text-neutral-700">
          Estimated {budget.estimated.toLocaleString()} tokens of {budget.limit.toLocaleString()} allowed.
        </p>
        {!budget.ok ? (
          <div role="alert" className={ERROR_BOX}>
            <p>Too much text for this model. Remove a document or shorten the epic text, then re-run checks.</p>
          </div>
        ) : null}
      </section>

      <section className={`${card} flex flex-col gap-3`}>
        <h2 className="text-lg font-semibold">Ticket structure</h2>
        {structure.errors.length > 0 ? (
          <div role="alert" className={ERROR_BOX}>
            {list(structure.errors, "")}
          </div>
        ) : null}
        {structure.warnings.length > 0 ? <div className={WARNING_BOX}>{list(structure.warnings, "")}</div> : null}
        {structure.notes.length > 0 ? list(structure.notes, "text-sm text-neutral-700") : null}
        {structure.errors.length === 0 && structure.warnings.length === 0 && structure.notes.length === 0 ? (
          <p className="text-sm text-neutral-600">The guidelines define the structure without problems.</p>
        ) : null}
        {checks.existingEpicError ? (
          <div role="alert" className={ERROR_BOX}>
            {checks.existingEpicError}
          </div>
        ) : null}
      </section>

      <section className={`${card} flex flex-col gap-4`}>
        <h2 className="text-lg font-semibold">Routing</h2>
        {roster.teams.length === 0 && roster.people.length === 0 && roster.rules.length === 0 ? (
          <p className="text-sm text-neutral-600">No routing file. Tickets will use the default assignee.</p>
        ) : null}

        {roster.teams.length > 0 ? (
          <div className="overflow-x-auto">
            <h3 className="mb-2 text-sm font-semibold">Teams</h3>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={HEAD}>Team</th>
                  <th className={HEAD}>Default person</th>
                </tr>
              </thead>
              <tbody>
                {roster.teams.map((team) => {
                  const resolved = roster.teamDefaults[team.name];
                  return (
                    <tr key={team.name}>
                      <td className={CELL}>{team.name}</td>
                      <td className={CELL}>
                        {resolved ? (
                          resolved.displayName
                        ) : (
                          <span className="text-amber-800">
                            ⚠ {team.defaultPerson} is not an assignable user
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {roster.people.length > 0 ? (
          <div className="overflow-x-auto">
            <h3 className="mb-2 text-sm font-semibold">People</h3>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={HEAD}>Name</th>
                  <th className={HEAD}>Role</th>
                </tr>
              </thead>
              <tbody>
                {roster.people.map((person) => (
                  <tr key={person.name}>
                    <td className={CELL}>{person.name}</td>
                    <td className={CELL}>{person.role ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {roster.rules.length > 0 ? (
          <div className="overflow-x-auto">
            <h3 className="mb-2 text-sm font-semibold">Rules</h3>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={HEAD}>Id</th>
                  <th className={HEAD}>Line</th>
                  <th className={HEAD}>Quote</th>
                  <th className={HEAD}>Target</th>
                </tr>
              </thead>
              <tbody>
                {roster.rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className={CELL}>{rule.id}</td>
                    <td className={CELL}>{rule.line}</td>
                    <td className={CELL}>{rule.quote}</td>
                    <td className={CELL}>
                      {rule.target.type}: {rule.target.name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {roster.unresolved.length > 0 ? (
          <div role="alert" className={ERROR_BOX}>
            <p className="mb-2 font-medium">Names that need a fix in the routing file</p>
            <ul className="flex flex-col gap-2">
              {roster.unresolved.map((entry) => (
                <li key={`${entry.reason}-${entry.name}`}>
                  <span className="font-medium">{entry.name}</span>:{" "}
                  {entry.reason === "ambiguous" ? "more than one user matches" : "no matching user"}
                  {entry.suggestions.length > 0 ? (
                    <span>
                      {" "}
                      Did you mean{" "}
                      {entry.suggestions.map((user, index) => (
                        <span key={user.accountId}>
                          {index > 0 ? ", " : ""}
                          <span className="font-medium">{user.displayName}</span>
                        </span>
                      ))}
                      ?
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-700">
          Fix files on the{" "}
          <Link href={projectHref} className="font-medium underline">
            project page
          </Link>
          , then re-run checks.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={secondaryButton} onClick={onBack} disabled={busy !== null}>
            Back to inputs
          </button>
          <button type="button" className={secondaryButton} onClick={onRerun} disabled={busy !== null}>
            Re-run checks
          </button>
          <button type="button" className={primaryButton} onClick={onContinue} disabled={blocked || busy !== null}>
            Continue
          </button>
          {busy ? <Spinner label={busy} /> : null}
        </div>
      </div>
    </div>
  );
}
