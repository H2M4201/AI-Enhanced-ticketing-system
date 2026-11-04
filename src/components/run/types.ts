import type { ClarifyingQuestion, Resolution } from "@/core/domain";
import type { RunDocumentView } from "@/server/runs/service";

/** A run's status as the server stores it. */
export type RunStatus = "inputs" | "checked" | "questions" | "review" | "creating" | "done";

/** A clarifying question with the answer saved for it, if any. */
export type QuestionView = ClarifyingQuestion & { resolution: Resolution | null };

/** The run page's stored state, as GET /api/runs/[id] returns it. */
export type RunDetail = {
  run: {
    id: string;
    projectId: string;
    status: RunStatus;
    epicText: string;
    existingEpicKey: string | null;
    clarificationsWritten: boolean;
    draftVersion: number;
    completedAt: string | null;
  };
  documents: RunDocumentView[];
  checks: { structure: unknown; roster: unknown; assignableUsers: unknown };
  questions: QuestionView[];
};
