# Epic-to-Backlog Copilot

A web app that turns an epic and its supporting documents into a reviewed set of Jira Cloud tickets. It checks the team's ticket structure and routing rules, asks clarifying questions, drafts an epic → story → sub-task breakdown, routes every ticket to a person with the rule it used, and creates the tickets only after a person has reviewed them.

Uploaded documents are confidential. The app never writes document text, prompts or model output to logs.

## What you must set up yourself

The app cannot be run end to end without these. Claude or any other automated assistant cannot create them for you, and you must not share real credentials with anyone else.

1. **A Jira Cloud test site.** Create a free site that is not production. Create a scrum or kanban project in it, and add a few users to route tickets to.
2. **An OAuth 2.0 (3LO) app** in the Atlassian developer console. Register this callback URL exactly:
   `http://localhost:3000/api/auth/callback/atlassian`

   Grant these scopes:
   `read:jira-work write:jira-work read:jira-user read:me offline_access`

   Copy the client ID and client secret into `.env.local`.
3. **An LLM endpoint and key.** Any OpenAI-compatible chat endpoint works. You can enter the key in the app's settings, or put it in `.env.local`. See [AI provider](#ai-provider) below before you choose one.

## Prerequisites

- Node.js 24
- npm
- Windows, macOS or Linux. No Docker is needed. The app uses an embedded database by default.

## Setup

```bash
npm install
cp .env.example .env.local
```

On Windows PowerShell, use `Copy-Item .env.example .env.local`.

Fill in `.env.local`:

- `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` from your OAuth app.
- `SESSION_SECRET`: at least 32 characters. Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```

- `ENCRYPTION_KEY`: base64 of exactly 32 bytes, used for AES-256-GCM encryption of stored API keys and Jira tokens. Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

  Keep this key. Changing it makes stored keys and tokens unreadable.

Then start the app:

```bash
npm run dev
```

Open http://localhost:3000, sign in with Atlassian, and pick your Jira test project.

## AI provider

Set the provider in the app's settings, or in `.env.local` with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and `LLM_CONTEXT_TOKENS`. The app speaks the OpenAI-compatible chat API, so you can switch providers by changing these values.

**Cloud providers receive your document text.** Any hosted model (OpenAI, Azure, Gemini, OpenRouter, a company gateway and so on) sends the epic, documents, guidelines and routing file to that provider. Check that your provider's terms allow this for your documents before you upload anything confidential.

**For confidential documents, use a local model.** With [Ollama](https://ollama.com), no document text leaves your machine:

```bash
ollama pull llama3.1
```

Then set:

```
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3.1
```

Ollama ignores the key, but the field must not be empty. Use a model with a context window that fits your inputs, and set `LLM_CONTEXT_TOKENS` to match it.

## Database

Without `DATABASE_URL`, the app uses an embedded database, PGlite, stored at `./.data/pglite`. See [Known deviations](#known-deviations-from-the-plan).

To use a real Postgres server, set `POSTGRES_PASSWORD` first. The included `docker-compose.yml` requires it and does not start without it:

```bash
export POSTGRES_PASSWORD=<choose a password>
docker compose up -d
```

On Windows PowerShell, use `$env:POSTGRES_PASSWORD = "<choose a password>"`, then run `docker compose up -d`.

Then set this in `.env.local`, with the same password:

```
DATABASE_URL=postgres://copilot:<password>@localhost:5432/copilot
```

Docker is optional. Any Postgres 17 server works if it has a `copilot` user and a `copilot` database.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the app at http://localhost:3000 |
| `npm test` | Runs the automated tests. They use a fake LLM and a fake Jira, and need no network access |
| `npm run typecheck` | TypeScript check |
| `npm run samples` | Rebuilds the binary sample documents in `samples/checkout-revamp` from their Markdown sources |
| `npm run eval` | Runs the pipeline on the Checkout Revamp sample with your configured LLM and prints a table |
| `npm run backdate -- <runId> <days>` | Backdates one run so the retention purge treats it as expired. Used by the smoke test. Stop the app first |

### Evaluating a model

`npm run eval` reads `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` from the environment or `.env.local`. To try several models, write one JSON file per model and pass it in:

```bash
npm run eval -- --profile-json path/to/profile.json
```

The profile is a JSON object with any of `baseUrl`, `apiKey`, `model`, `supportsJsonMode` and `contextTokens`. Missing fields come from the environment.

The evaluation creates tickets in a fake Jira project, not in your Jira site. It prints a table of steps, planted-flaw detection, item counts and routing coverage. It writes the same data as JSON to `./.data/`. Neither output contains document text, prompts or model output.

## Known deviations from the plan

- **Team routing uses components only.** A team in the routing file becomes a Jira component with the same name. The Jira Team field is not set, because it needs Atlassian Teams IDs, and that is deferred.
- **Single-call draft generation.** The epic, stories and tasks come from one model call, not a staged process. Very large inputs may fit poorly in a small context window. The app checks the input size before it calls the model.
- **PGlite is the default database, not Postgres.** The build machine has no Docker, so the default is the embedded PGlite database at `./.data/pglite`. Postgres is optional and is enabled by setting `DATABASE_URL`.
- **Required custom fields support text values only.** A required Jira field is filled from a text box in the review. Fields that need an option, a user, a date or another structure cannot be set in the app yet.
- **File permissions on a project.** Any member who can browse the Jira project may upload or replace its guideline and routing files. Only the owner can remove them. This is intended.
- **Guideline-requested Jira labels are not applied.** Created issues get only `ai-backlog`, `ai-run-<first 8 characters of the run ID>`, and `ai-suggested` on accepted AI suggestions. A label that a guideline file asks for, such as `checkout`, is not added.

## Testing

```bash
npm test
npm run typecheck
```

For the live end-to-end check against your Jira test site, follow [docs/smoke-test.md](docs/smoke-test.md).

## Data handling

- Uploaded documents, their extracted text and the epic text are deleted after the retention period. The default is `RETENTION_DAYS=7`, and the owner can change it per project. A purge runs at startup and then every hour.
- API keys and Jira tokens are encrypted at rest. The UI shows only the last four characters of a key.
- Logs record IDs, counts, timings and error codes only.
