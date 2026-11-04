import { APICallError, RetryError } from "ai";
import { ZodError, type z } from "zod";
import { LlmOutputError } from "@/core/llm/structured";
import { DocumentParseError } from "@/core/ingest/parse";
import { CreateBlockedError } from "@/core/pipeline/create";
import { TreeError } from "@/core/tree";
import { JiraError } from "@/integrations/jira/client";
import { safeLog } from "@/lib/log";
import {
  ForbiddenError,
  NoProviderError,
  NotFoundError,
  ReauthRequiredError,
  RunStateError,
  UnauthorizedError,
} from "@/server/errors";

/** A request problem the route detects itself. The message is ours, so it may be returned to the client. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const INTERNAL_MESSAGE = "Something went wrong";
const LLM_PROVIDER_NO_STATUS_MESSAGE = "The AI provider could not be reached. Check the provider's URL.";
const LLM_OUTPUT_MESSAGE = "The AI returned an unusable answer after 3 tries. Try again or switch model.";

/** The provider's HTTP failure inside an AI SDK error, directly or as the last error of a retry. */
function providerCallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error) && APICallError.isInstance(error.lastError)) return error.lastError;
  return null;
}

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/** Maps a thrown error to its HTTP response. Only the 500 path hides the message, and it logs no content. */
function toErrorResponse(error: unknown, step: string): Response {
  if (error instanceof UnauthorizedError) return errorResponse(401, "unauthorized", error.message);
  if (error instanceof ReauthRequiredError) return errorResponse(401, "reauth_required", error.message);
  if (error instanceof ForbiddenError) return errorResponse(403, "forbidden", error.message);
  if (error instanceof NotFoundError) return errorResponse(404, "not_found", error.message);
  if (error instanceof RunStateError) return errorResponse(409, "run_state", error.message);
  if (error instanceof NoProviderError) return errorResponse(409, "no_provider", error.message);
  if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "body";
    return errorResponse(400, "invalid_request", `Invalid request: ${where} ${issue?.message ?? "is invalid"}`);
  }
  if (error instanceof DocumentParseError) return errorResponse(422, "parse_error", error.message);
  if (error instanceof TreeError) return errorResponse(422, "invalid_edit", error.message);
  if (error instanceof CreateBlockedError) {
    return errorResponse(409, "blocked", error.message, { blockers: error.blockers });
  }
  if (error instanceof LlmOutputError) return errorResponse(502, "llm_output", LLM_OUTPUT_MESSAGE);
  if (error instanceof JiraError) return errorResponse(502, "jira", error.messages.join("; "));
  const providerError = providerCallError(error);
  if (providerError !== null) {
    // Only the status goes to the client: the request and response bodies can hold document text.
    const status = providerError.statusCode;
    return errorResponse(
      502,
      "llm_provider",
      status === undefined
        ? LLM_PROVIDER_NO_STATUS_MESSAGE
        : `The AI provider rejected the request (HTTP ${status}). Check the provider's URL, key and model.`,
    );
  }

  safeLog("request.failed", {
    step,
    errorCode: error instanceof Error ? error.name : "unknown",
    httpStatus: 500,
  });
  return errorResponse(500, "internal", INTERNAL_MESSAGE);
}

/**
 * Runs a route's work and returns its response. A Response is returned as it is; any other value
 * is sent as JSON with status 200. `step` names the route in the log line for a 500.
 */
export async function handle(fn: () => Promise<unknown>, step = "api"): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return Response.json(result ?? { ok: true });
  } catch (error) {
    return toErrorResponse(error, step);
  }
}

/** Parses and validates a JSON request body. A body that is not JSON is a 400. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid_request", "Request body must be JSON");
  }
  return schema.parse(body);
}

/** Reads a multipart form body. A body that is not a form is a 400. */
export async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new HttpError(400, "invalid_request", "Request body must be a multipart form");
  }
}

/** Upload limits. Checked against file.size before the bytes are read. */
export const PROJECT_FILE_MAX_BYTES = 200 * 1024;
export const RUN_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** The file in a form field. Refuses a missing field with 400 and an oversized file with 413. */
export function uploadedFile(form: FormData, field: string, maxBytes: number, maxLabel: string): File {
  const value = form.get(field);
  if (!(value instanceof File)) throw new HttpError(400, "invalid_request", `Upload a file in the "${field}" field`);
  if (value.size > maxBytes) throw new HttpError(413, "too_large", `The file is larger than the ${maxLabel} limit`);
  return value;
}
