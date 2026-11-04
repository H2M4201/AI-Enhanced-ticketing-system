import type { ItemKind } from "@/core/domain";
import { keyUrl } from "@/components/review/model";

const TAG = "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap";

const TYPE_STYLE: Record<ItemKind, string> = {
  epic: "bg-[#6b4fbb] text-white",
  story: "bg-[#2e8b57] text-white",
  task: "bg-[#2f6fb3] text-white",
};

/** The item's kind in capitals, coloured by kind. */
export function TypeTag({ kind }: { kind: ItemKind }) {
  return <span className={`${TAG} ${TYPE_STYLE[kind]}`}>{kind.toUpperCase()}</span>;
}

/** Marks a draft item the AI suggested, which needs accepting or rejecting. */
export function AiTag() {
  return <span className={`${TAG} border border-dashed border-yellow-600 bg-yellow-100 text-yellow-900`}>AI suggestion</span>;
}

/** Marks an item whose details the draft had to assume. */
export function AssumptionTag() {
  return <span className={`${TAG} bg-neutral-200 text-neutral-800`}>Assumption</span>;
}

/** Marks an item whose assignee the PM or BA must choose. */
export function DecisionTag() {
  return <span className={`${TAG} bg-red-100 text-red-800`}>Needs decision</span>;
}

/** The Jira key of a created item, linked to its browse page when the site URL is known. */
export function KeyLink({ siteUrl, jiraKey }: { siteUrl: string | null; jiraKey: string }) {
  const href = keyUrl(siteUrl, jiraKey);
  if (href === null) return <span className="text-xs font-semibold text-neutral-700">{jiraKey}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-blue-700 underline">
      {jiraKey}
    </a>
  );
}
