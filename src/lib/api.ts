/** Client-side fetch helper for the app's /api routes. Used by client components only. */

/** A failed API call. `code` and `message` come from the server's `{ error: { code, message } }` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const INTERNAL_MESSAGE = "Something went wrong";
const SIGN_IN_PATH = "/api/auth/login";

function sendToSignIn(): void {
  if (typeof window === "undefined") return;
  // An API route that starts the Atlassian sign-in, not a Next.js page, so a full navigation is correct.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(SIGN_IN_PATH);
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } & Record<string, unknown> };
    const { code, message, ...details } = body.error ?? {};
    if (typeof code === "string" && typeof message === "string") {
      return new ApiError(response.status, code, message, details);
    }
  } catch {
    // Not JSON: fall through to the generic error.
  }
  return new ApiError(response.status, "internal", INTERNAL_MESSAGE);
}

/**
 * Calls an API route and returns its parsed JSON. Throws ApiError on any non-2xx response.
 * When the user must sign in again, the browser is sent to the sign-in route first.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const error = await readError(response);
    if (error.code === "reauth_required" || error.code === "unauthorized") sendToSignIn();
    throw error;
  }
  return (await response.json()) as T;
}

/** The project as GET /api/projects and GET /api/projects/[id] return it. */
export type ProjectView = {
  id: string;
  name: string;
  cloudId: string;
  siteUrl: string;
  jiraProjectKey: string;
  providerProfileId: string | null;
  retentionDays: number;
  owned: boolean;
  /** The provider the project uses, as the server resolves it. Null when none is configured. Never has a key. */
  provider: { source: "profile" | "env"; name: string; model: string; baseUrlHost: string } | null;
};

/** A provider profile as the owner sees it. The key is shown only as its last four characters. */
export type ProfileView = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  supportsJsonMode: boolean;
  contextTokens: number;
  apiKeyMasked: string;
};

/** An active guideline or routing file of a project. */
export type FileView = {
  id: string;
  kind: "guideline" | "routing";
  filename: string;
  version: number;
  uploadedAt: string;
};

export type SiteView = { cloudId: string; name: string; url: string };

export type JiraProjectView = { id: string; key: string; name: string };

/** The message to show a user for a failed call. Always plain text. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}
