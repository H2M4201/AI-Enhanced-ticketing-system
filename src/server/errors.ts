/** No LLM provider is configured: the project has no profile and no environment default is set. */
export class NoProviderError extends Error {
  constructor() {
    super("No LLM provider is configured for this project");
    this.name = "NoProviderError";
  }
}

/** The run is not in a state that allows the requested action. */
export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStateError";
  }
}

/** A project, run, document, question, draft item, provider profile or user was not found. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
