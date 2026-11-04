/** Thin HTTP client for Jira Cloud REST v3, reached through the Atlassian OAuth gateway. */

const GATEWAY = "https://api.atlassian.com/ex/jira";

export class JiraError extends Error {
  readonly status: number;
  readonly messages: string[];

  constructor(status: number, messages: string[]) {
    super(messages.join("; ") || `Jira request failed with status ${status}`);
    this.name = "JiraError";
    this.status = status;
    this.messages = messages;
  }
}

/** Collects errorMessages and errors values from a Jira error body. */
function messagesFrom(text: string, status: number): string[] {
  try {
    const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown };
    const messages = [
      ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages : []),
      ...(parsed.errors && typeof parsed.errors === "object" ? Object.values(parsed.errors) : []),
    ].filter((m): m is string => typeof m === "string" && m.length > 0);
    if (messages.length > 0) return messages;
  } catch {
    // Not JSON; fall through to the generic message.
  }
  return [`Jira request failed with status ${status}`];
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
    if (!res.ok) throw new JiraError(res.status, messagesFrom(text, res.status));
    return (text ? JSON.parse(text) : undefined) as T;
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
