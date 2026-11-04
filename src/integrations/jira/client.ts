/** Thin HTTP client for Jira Cloud REST v3, reached through the Atlassian OAuth gateway. */

const GATEWAY = "https://api.atlassian.com/ex/jira";

export class JiraError extends Error {
  readonly status: number;
  readonly messages: string[];
  /** Parsed response body, or undefined when the body was empty or not JSON. */
  readonly body: unknown;

  constructor(status: number, messages: string[], body?: unknown) {
    super(messages.join("; ") || `Jira request failed with status ${status}`);
    this.name = "JiraError";
    this.status = status;
    this.messages = messages;
    this.body = body;
  }
}

function nonEmptyStrings(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Collects messages from a Jira error body: errorMessages, errors as an object, or errors as a per-element array. */
function messagesFrom(body: unknown, status: number): string[] {
  if (body && typeof body === "object") {
    const { errorMessages, errors } = body as { errorMessages?: unknown; errors?: unknown };
    const messages: unknown[] = Array.isArray(errorMessages) ? [...errorMessages] : [];
    if (Array.isArray(errors)) {
      for (const element of errors as { elementErrors?: { errorMessages?: unknown; errors?: unknown } }[]) {
        const e = element?.elementErrors;
        if (Array.isArray(e?.errorMessages)) messages.push(...e.errorMessages);
        if (e?.errors && typeof e.errors === "object") messages.push(...Object.values(e.errors));
      }
    } else if (errors && typeof errors === "object") {
      messages.push(...Object.values(errors));
    }
    const found = nonEmptyStrings(messages);
    if (found.length > 0) return found;
  }
  return [`Jira request failed with status ${status}`];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class JiraHttp {
  private readonly base: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { cloudId: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }) {
    this.base = `${GATEWAY}/${opts.cloudId}`;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Sends one request. On 401 it fetches a fresh token and retries once. Empty bodies return undefined. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await this.send(method, path, body, await this.getToken());
    if (res.status === 401) {
      await res.text();
      res = await this.send(method, path, body, await this.getToken());
    }
    const text = await res.text();
    const parsed = text ? parseJson(text) : undefined;
    if (!res.ok) throw new JiraError(res.status, messagesFrom(parsed, res.status), parsed);
    if (!text) return undefined as T;
    if (parsed === undefined) throw new JiraError(res.status, ["Invalid JSON response from Jira"]);
    return parsed as T;
  }

  private send(method: string, path: string, body: unknown, token: string): Promise<Response> {
    const hasBody = body !== undefined;
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  }
}
