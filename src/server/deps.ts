import { createLlmClient } from "@/core/llm/client";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraHttp } from "@/integrations/jira/client";
import { getValidAccessToken } from "@/server/auth/tokens";
import { getDb } from "@/server/db/client";
import { resolveProviderConfig } from "@/server/providers";
import type { RunDeps } from "@/server/runs/service";

/** The production wiring for RunService: real LLM provider, Jira calls made with the acting user's token. */
export async function runDeps(): Promise<RunDeps> {
  const db = await getDb();
  return {
    db,
    llmFor: async (project) => createLlmClient(await resolveProviderConfig(db, project)),
    adapterFor: async (userId, project) =>
      new JiraCloudAdapter(
        new JiraHttp({
          cloudId: project.cloudId,
          getToken: (opts) => getValidAccessToken(db, userId, { forceRefresh: opts?.forceRefresh }),
        }),
      ),
    contextTokensFor: async (project) => (await resolveProviderConfig(db, project)).contextTokens,
  };
}
