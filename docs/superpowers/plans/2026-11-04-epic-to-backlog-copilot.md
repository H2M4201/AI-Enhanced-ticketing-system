# Epic-to-Backlog Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js web app where a PM/BA uploads an epic, reference docs, guideline files and a routing file; the AI asks clarifying questions, drafts a routed epic → story → task tree for review, and creates the tickets in Jira Cloud.

**Architecture:** One Next.js (App Router) TypeScript project. Pure domain logic lives in `src/core/` and never imports Next.js, the database or Jira. Two interfaces sit at the edges: `LlmClient` (OpenAI-compatible via Vercel AI SDK; a fake for tests) and `TicketingAdapter` (Jira Cloud; a fake for tests). `src/server/` holds persistence (Drizzle on Postgres; PGlite when no `DATABASE_URL`), auth, access control and the run service that orchestrates the pipeline. `src/app/` holds pages and API route handlers.

**Tech Stack:** Node 24, npm, TypeScript (strict), Next.js (App Router) + React, Tailwind CSS, Drizzle ORM + `pg` + `@electric-sql/pglite`, `ai` + `@ai-sdk/openai-compatible`, `zod`, `iron-session`, `mammoth`, `jszip`, `unpdf`, `node-html-parser`; dev: `vitest`, `@testing-library/react`, `jsdom`, `tsx`, `drizzle-kit`, `docx`, `pptxgenjs`, `pdf-lib`.

**Spec:** `docs/superpowers/specs/2026-11-04-epic-to-backlog-copilot-design.md`

## Global Constraints

- Language: TypeScript with `"strict": true`. Package manager: **npm**. Install current stable versions; commit `package-lock.json`.
- Machine: Windows 11, no Docker, no local Postgres. With `DATABASE_URL` unset, the app uses **PGlite** persisted at `./.data/pglite`. Tests use PGlite in memory. A `docker-compose.yml` for real Postgres is still provided. *(Plan-level change from the spec's "Docker Compose will be provided", made because Docker isn't installed.)*
- `src/core/**` must not import from `next`, `src/server/**`, `src/app/**`, drizzle or any Jira module except through the `TicketingAdapter` interface.
- **No document content, prompts or model output in logs.** All logging goes through `safeLog` (Task 1).
- **No secrets in source.** Secrets come from `.env.local` (git-ignored). `.env.example` lists every variable with empty values.
- API keys and OAuth refresh/access tokens are stored **encrypted** (AES-256-GCM, key from `ENCRYPTION_KEY`). The UI shows only the last 4 characters of a key.
- OAuth callback URL: `http://localhost:3000/api/auth/callback/atlassian`. Scopes: `read:jira-work write:jira-work read:jira-user read:me offline_access`.
- Labels on every created issue: `ai-backlog` and `ai-run-<first 8 chars of run id>`. Accepted AI suggestions also get `ai-suggested`.
- Description footer on every created issue: a final paragraph `ai-backlog-item: <draftItemId>`.
- AI-suggestion description prefix (exact): `Proposed by AI and accepted by <displayName>.`
- Epic clarifications heading (exact): `Clarifications`. It is appended to an existing epic and never overwrites it.
- Fallback structure when guidelines don't specify one: Epic → Story → Sub-task, with the notice text `Guidelines don't define a ticket structure; using Epic → Story → Sub-task.`
- Clarifying questions: at most **10**, ranked 1 = most important.
- Retention default: **7** days (`RETENTION_DAYS`). The purge runs at startup and then every hour.
- Access-check cache TTL: **5 minutes**.
- Structured-output retries: **3** attempts in total.
- Context budget: estimated tokens = `ceil(chars / 4)`. Inputs must fit within `contextTokens - 8000`.
- Mocks or fakes (`FakeLlm`, `FakeTicketingAdapter`) are imported only from tests and `scripts/eval.ts`, never from `src/app` or `src/server` runtime paths.

## Review Focus

1. **An empty or textless upload** (empty .txt, scanned PDF with no text layer) → a clear error naming the file, never a silently empty document. *Test in Task 4.*
2. **Model output that isn't clean JSON** (wrapped in ```` ```json ```` fences or prose, or truncated) → the JSON is extracted when present, otherwise retried, and after 3 attempts a clear `LlmOutputError`. *Test in Task 5.*
3. **The Jira access token expires mid-run** → it refreshes transparently. **The refresh token is revoked** → `ReauthRequiredError`, the UI sends the user to sign in, and the draft is untouched. *Test in Task 16.*
4. **One item in a bulk create fails** (e.g. an assignee who isn't assignable) → the other items are created, the failed one shows Jira's reason, and Retry creates only the failed one. *Test in Task 14.*
5. **Name matching with duplicates or Vietnamese diacritics** (two "Minh"s, "Nguyễn" vs "Nguyen") → diacritic-insensitive matching, but a name matching more than one user is *unresolved (ambiguous)*, never the first match. *Test in Task 10.*

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, drizzle.config.ts,
docker-compose.yml, .env.example, .gitignore, README.md
src/
  lib/
    env.ts                 getEnv(): validated env (lazy)
    crypto.ts              encryptSecret / decryptSecret
    log.ts                 safeLog
  core/                    pure domain logic (no Next/DB/Jira imports)
    domain.ts              shared zod schemas + types
    tree.ts                draft tree validation + edit operations
    blockers.ts            computeBlockers
    ingest/
      sections.ts          splitMarkdown, splitPlainText
      parse.ts             parseDocument (dispatch) + DocumentParseError
      docx.ts, pptx.ts, pdf.ts
    llm/
      client.ts            LlmClient, ChatMessage, ProviderConfig, createLlmClient
      structured.ts        generateValidated, extractJson, LlmOutputError
      budget.ts            estimateTokens, checkContextBudget
      prompts.ts           renderPrompt
      prompts/*.md         structure, roster, clarify, draft, route
    ticketing/
      adapter.ts           TicketingAdapter + data types
    pipeline/
      structure.ts         extractStructure, validateStructure
      roster.ts            parseRoster, resolveRoster, normalizeName
      clarify.ts           generateQuestions
      draft.ts             generateDraft
      route.ts             routeItems
      create.ts            createInTicketing
  integrations/
    jira/
      adf.ts               textToAdf, adfToText
      client.ts            JiraHttp (fetch wrapper)
      adapter.ts           JiraCloudAdapter implements TicketingAdapter
  server/
    db/
      schema.ts            Drizzle tables
      client.ts            createDb, getDb, migrate
    auth/
      atlassian.ts         OAuth calls
      session.ts           iron-session helpers, requireUser
      tokens.ts            getValidAccessToken, ReauthRequiredError
    access.ts              canAccessProject, assertOwner
    providers.ts           provider profile repo + resolveProviderConfig
    projects.ts            project + project file repo
    runs/
      repo.ts              run/doc/question/draft persistence
      service.ts           RunService (pipeline orchestration)
    retention.ts           purgeExpired, startRetentionLoop
  app/                     pages + route handlers (Tasks 17-20)
  instrumentation.ts       starts retention loop
tests/                     mirrors src/ (vitest)
  helpers/fake-llm.ts, helpers/fake-ticketing.ts, helpers/db.ts
samples/checkout-revamp/   fictional inputs (+ generated docx/pptx/pdf)
samples/fake-jira-project.json
scripts/build-samples.ts, scripts/eval.ts
```

---

### Task 1: Project scaffold, env, crypto, safe logging

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`, `src/lib/env.ts`, `src/lib/crypto.ts`, `src/lib/log.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Modify: `.gitignore` (add `.data/`, `coverage/`)
- Test: `tests/lib/crypto.test.ts`, `tests/lib/log.test.ts`, `tests/lib/env.test.ts`

**Interfaces:**
- Produces:
  - `getEnv(): Env` with `Env = { ATLASSIAN_CLIENT_ID: string; ATLASSIAN_CLIENT_SECRET: string; APP_URL: string /* default http://localhost:3000 */; SESSION_SECRET: string /* min 32 chars */; ENCRYPTION_KEY: string /* base64 of 32 bytes */; DATABASE_URL?: string; LLM_BASE_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string; LLM_CONTEXT_TOKENS: number /* default 128000 */; RETENTION_DAYS: number /* default 7 */ }`. It throws `Error` listing the invalid variable names (never their values). It is validated lazily on first call and cached; `resetEnvCache()` is exported for tests.
  - `encryptSecret(plain: string): string` → `v1:<iv b64>:<tag b64>:<ciphertext b64>`; `decryptSecret(enc: string): string`; `maskSecret(plain: string): string` → `••••` + last 4 chars.
  - `safeLog(event: string, meta?: Record<string, string | number | boolean | null>): void`. Only these keys are kept: `runId, projectId, userId, itemId, count, durationMs, status, step, attempt, errorCode, httpStatus, model`. Other keys are dropped. String values are cut to 120 chars. Output is one JSON line to stdout.

- [ ] **Step 1: Scaffold.** Run `npx create-next-app@latest . --ts --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --no-turbopack` (accept overwriting nothing in `docs/`). Then `npm i zod` and `npm i -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom tsx`. Add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"typecheck": "tsc --noEmit"`. `vitest.config.ts`: node environment by default, `@` alias to `src`, `tests/**/*.test.ts?(x)`.
- [ ] **Step 2: Write failing tests**

```ts
// tests/lib/crypto.test.ts
beforeEach(() => { process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); /* + other required vars */ resetEnvCache(); });
it('round-trips', () => expect(decryptSecret(encryptSecret('sk-abc123'))).toBe('sk-abc123'));
it('uses a fresh IV each time', () => expect(encryptSecret('x')).not.toBe(encryptSecret('x')));
it('rejects tampered ciphertext', () => { const e = encryptSecret('x'); const parts = e.split(':'); parts[3] = Buffer.from('zz').toString('base64'); expect(() => decryptSecret(parts.join(':'))).toThrow(); });
it('masks', () => expect(maskSecret('sk-abcdef1234')).toBe('••••1234'));

// tests/lib/log.test.ts
it('drops non-allowlisted keys such as content', () => {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  safeLog('draft.generated', { runId: 'r1', count: 5, content: 'SECRET REQUIREMENT TEXT' } as any);
  const line = String(spy.mock.calls[0][0]);
  expect(line).toContain('"runId":"r1"'); expect(line).not.toContain('SECRET');
});

// tests/lib/env.test.ts
it('reports missing variable names without values', () => { delete process.env.SESSION_SECRET; resetEnvCache(); expect(() => getEnv()).toThrow(/SESSION_SECRET/); });
it('applies defaults', () => { /* set required */ resetEnvCache(); expect(getEnv().RETENTION_DAYS).toBe(7); expect(getEnv().APP_URL).toBe('http://localhost:3000'); });
```

- [ ] **Step 3: Run** `npx vitest run tests/lib` → FAIL (modules missing).
- [ ] **Step 4: Implement** `src/lib/env.ts` (zod schema with `z.coerce.number()` defaults), `src/lib/crypto.ts` (node `crypto` aes-256-gcm, 12-byte IV) and `src/lib/log.ts`. `.env.example` lists every `Env` key with empty values and comments: how to generate `ENCRYPTION_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and the OAuth callback URL.
- [ ] **Step 5: Run** `npx vitest run tests/lib && npm run typecheck && npm run build` → all pass. The build uses the default home page.
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: scaffold Next.js app with env, crypto and safe logging"`

---

### Task 2: Database schema and client

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `drizzle.config.ts`, `drizzle/` (generated migrations), `docker-compose.yml`, `tests/helpers/db.ts`
- Test: `tests/server/db.test.ts`

**Interfaces:**
- Consumes: `getEnv()` (Task 1).
- Produces:
  - `type Db` (Drizzle Postgres database type usable with both drivers). `createDb(url?: string): Promise<Db>`: a `postgres://`/`postgresql://` URL → node-postgres; `memory://` → PGlite in memory; anything else or undefined → PGlite at `./.data/pglite`. It runs migrations from `./drizzle` before returning. `getDb(): Promise<Db>` is a singleton using `getEnv().DATABASE_URL`.
  - `tests/helpers/db.ts`: `testDb(): Promise<Db>` = `createDb('memory://')`.
  - Tables (all ids `uuid` default random, timestamps `timestamptz` default now):
    - `users`: `id, atlassianAccountId (unique), displayName, email?, accessTokenEnc, refreshTokenEnc, accessTokenExpiresAt, createdAt`
    - `providerProfiles`: `id, ownerUserId → users, name, baseUrl, apiKeyEnc, model, supportsJsonMode boolean default false, contextTokens int default 128000, createdAt`
    - `projects`: `id, ownerUserId → users, name, cloudId, siteUrl, jiraProjectKey, providerProfileId → providerProfiles nullable, retentionDays int default 7, createdAt`. Unique `(cloudId, jiraProjectKey)`.
    - `projectFiles`: `id, projectId → projects cascade, kind ('guideline'|'routing'), filename, content text, sha256, version int, active boolean, uploadedBy → users, createdAt`
    - `runs`: `id, projectId cascade, createdBy → users, epicText, existingEpicKey?, status ('inputs'|'checked'|'questions'|'review'|'creating'|'done'), fileVersions jsonb (`{fileId, sha256}[]`), structure jsonb?, roster jsonb?, clarificationsWritten boolean default false, lastActivityAt, completedAt?, createdAt`
    - `runDocuments`: `id, runId cascade, filename, kind, sections jsonb? (null after purge), charCount int, deletedAt?`
    - `clarifyingQuestions`: `id, runId cascade, category, text, sourceRefs jsonb, rank int, resolution jsonb?`
    - `draftItems`: `id (uuid, not defaulted: set by app), runId cascade, parentId?, position int, kind ('epic'|'story'|'task'), title, description, acceptanceCriteria jsonb, estimate real?, sourceRefs jsonb, origin, assumption boolean, shapedBy jsonb, suggestionStatus?, routing jsonb?, fieldValues jsonb default {}, jiraKey?, createError?`

- [ ] **Step 1: Install** `npm i drizzle-orm pg @electric-sql/pglite` and `npm i -D drizzle-kit @types/pg`. `docker-compose.yml`: a `postgres:17` service on 5432 with a volume.
- [ ] **Step 2: Write failing test**

```ts
// tests/server/db.test.ts
it('migrates and round-trips a project with files', async () => {
  const db = await testDb();
  const [u] = await db.insert(users).values({ atlassianAccountId: 'acc-1', displayName: 'Linh', accessTokenEnc: 'x', refreshTokenEnc: 'y', accessTokenExpiresAt: new Date() }).returning();
  const [p] = await db.insert(projects).values({ ownerUserId: u.id, name: 'Shop', cloudId: 'c1', siteUrl: 'https://x.atlassian.net', jiraProjectKey: 'CHK' }).returning();
  expect(p.retentionDays).toBe(7);
  await expect(db.insert(projects).values({ ownerUserId: u.id, name: 'dup', cloudId: 'c1', siteUrl: 's', jiraProjectKey: 'CHK' })).rejects.toThrow();
});
it('cascades run deletion to draft items', async () => { /* insert run + draftItem, delete run, expect 0 draft items */ });
```

- [ ] **Step 3: Run** `npx vitest run tests/server/db.test.ts` → FAIL.
- [ ] **Step 4: Implement** the schema, then `npx drizzle-kit generate` (dialect postgresql, schema `src/server/db/schema.ts`, out `./drizzle`). Implement `createDb` using `drizzle-orm/pglite` + `drizzle-orm/pglite/migrator`, and `drizzle-orm/node-postgres` + its migrator.
- [ ] **Step 5: Run** the test → PASS. `npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git commit -am "feat(db): add schema, migrations and PGlite/Postgres client"` (add the new files first).

---

### Task 3: Domain types and draft-tree operations

**Files:**
- Create: `src/core/domain.ts`, `src/core/tree.ts`, `src/core/blockers.ts`
- Test: `tests/core/tree.test.ts`, `tests/core/blockers.test.ts`

**Interfaces:**
- Produces (`src/core/domain.ts`; each type is `z.infer` of an exported schema of the same name + `Schema`):
  - `Section = { ref: string; heading: string | null; text: string }`. `ref` format: `<filename> §<n>` (n = heading number path like `3.2`, else running index), `<filename> slide <n>`, `<filename> p.<n>`.
  - `ParsedDocument = { filename: string; kind: 'docx'|'pptx'|'pdf'|'md'|'txt'; sections: Section[] }`
  - `ItemKind = 'epic'|'story'|'task'`
  - `Routing = { status: 'assigned'|'needs_decision'; accountId: string|null; displayName: string|null; teamName: string|null; reason: string; ruleId: string|null; ruleQuote: string|null; ruleLine: number|null; overridden: boolean }`
  - `DraftItem = { id: string; parentId: string|null; position: number; kind: ItemKind; title: string; description: string; acceptanceCriteria: string[]; estimate: number|null; sourceRefs: string[]; origin: 'from_docs'|'ai_suggestion'; assumption: boolean; shapedBy: string[]; suggestionStatus: 'pending'|'accepted'|'rejected'|null; routing: Routing|null; fieldValues: Record<string, unknown>; jiraKey: string|null; createError: string|null }`
  - `QuestionCategory = 'contradiction'|'ambiguity'|'missing'`; `ClarifyingQuestion = { id: string; category; text: string; sourceRefs: string[]; rank: number }`; `Resolution = { kind: 'answered'; answer: string } | { kind: 'out_of_scope' } | { kind: 'judgment' }`
  - `StructurePlan = { specified: boolean; epicType: string; storyType: string; taskType: string; taskLinkType: string /* default 'Relates' */; notes: string[] }`
  - `RosterRule = { id: string; condition: string; target: { type: 'person'|'team'; name: string }; line: number; quote: string }`; `Roster = { teams: { name: string; defaultPerson: string; members: string[] }[]; people: { name: string; role: string|null }[]; rules: RosterRule[] }`
- Produces (`src/core/tree.ts`, all pure; each returns a new array; invalid operations throw `TreeError(message)`):
  - `validateTree(items: DraftItem[]): void`. Exactly one epic with `parentId null`; story parent must be the epic; task parent must be a story; no cycles; ids unique.
  - `addItem(items, input: { parentId: string; kind: 'story'|'task'; title: string }): { items: DraftItem[]; id: string }` with origin `from_docs`, suggestionStatus `null`, routing `null`, position = last+1.
  - `deleteItem(items, id)`: removes the item and its descendants. Deleting the epic throws.
  - `moveItem(items, id, newParentId)`: keeps the kind rules and renumbers positions.
  - `updateItem(items, id, patch: Partial<Pick<DraftItem,'title'|'description'|'acceptanceCriteria'|'estimate'|'fieldValues'>>)`
  - `setSuggestionStatus(items, id, status: 'accepted'|'rejected')`. Throws if the item isn't an AI suggestion.
  - `overrideRouting(items, id, user: { accountId: string; displayName: string })` → routing `{ status:'assigned', overridden:true, reason:'Set manually', ruleId:null, ruleQuote:null, ruleLine:null, teamName: previous teamName }`
  - `activeItems(items)`: drops rejected suggestions and all their descendants.
- Produces (`src/core/blockers.ts`):
  - `Blocker = { itemId: string; type: 'pending_suggestion'|'needs_routing'|'missing_field'; message: string }`
  - `computeBlockers(items: DraftItem[], requiredFields: Record<ItemKind, { key: string; name: string }[]>): Blocker[]`. Only `activeItems` count. `pending_suggestion` when suggestionStatus is `pending`. `needs_routing` for story/task when routing is null or `needs_decision`. `missing_field` for each required field key absent from `fieldValues`. Items that already have a `jiraKey` are skipped.

- [ ] **Step 1: Write failing tests.** Use a helper `mk(partial)` that builds a `DraftItem` with defaults.

```ts
it('rejects a task directly under the epic', () => expect(() => validateTree([epic, mk({ id:'t', kind:'task', parentId: epic.id })])).toThrow(TreeError));
it('deleteItem removes descendants', () => expect(deleteItem([epic, s1, t1], s1.id).map(i => i.id)).toEqual([epic.id]));
it('moveItem refuses to move a story under a story', ...);
it('rejecting a suggestion hides its subtree from activeItems', () => { const items = setSuggestionStatus([epic, sugg, childOfSugg], sugg.id, 'rejected'); expect(activeItems(items).map(i=>i.id)).toEqual([epic.id]); });
it('overrideRouting marks overridden and keeps team', ...);
// blockers
it('flags pending suggestion, needs-decision routing and missing required field', () => {
  const b = computeBlockers([epic, mk({ id:'s', kind:'story', parentId: epic.id, origin:'ai_suggestion', suggestionStatus:'pending', routing: { ...needsDecision } })], { epic: [], story: [{ key:'customfield_1', name:'Team' }], task: [] });
  expect(b.map(x => x.type).sort()).toEqual(['missing_field','needs_routing','pending_suggestion']);
});
it('ignores rejected subtree and already-created items', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/core` → FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core): domain schemas, draft tree operations and blockers`

---

### Task 4: Sample inputs and document parsers

**Files:**
- Create: `samples/checkout-revamp/epic.md`, `requirements.md`, `design.md`, `api-spec.md`, `guidelines.md`, `routing.md`, `samples/fake-jira-project.json`, `scripts/build-samples.ts`; generated `samples/checkout-revamp/requirements.docx`, `design.pptx`, `api-spec.pdf` (committed)
- Create: `src/core/ingest/sections.ts`, `docx.ts`, `pptx.ts`, `pdf.ts`, `parse.ts`
- Test: `tests/core/ingest.test.ts`, fixtures `tests/fixtures/empty.txt` (0 bytes), `tests/fixtures/blank.pdf` (one page, no text; generated in the test with pdf-lib)

**Interfaces:**
- Consumes: `Section`, `ParsedDocument` (Task 3).
- Produces:
  - `parseDocument(filename: string, bytes: Uint8Array): Promise<ParsedDocument>`. Picks the parser by extension (case-insensitive): `.docx .pptx .pdf .md .markdown .txt`. Throws `DocumentParseError(filename, reason)` for unsupported types, and for documents whose total non-whitespace text is empty (`reason`: `no readable text — is it a scanned image?` for PDFs, `file is empty` otherwise).
  - `splitMarkdown(filename, text): Section[]`: splits on `#`–`###` headings; refs use heading number paths computed from nesting (`§1`, `§1.1`, `§2`); text before the first heading becomes `§0`, only if it's non-empty.
  - `splitPlainText(filename, text): Section[]`: lines that look like headings (`^\d+(\.\d+)*\s+\S` or ALL CAPS ≤ 60 chars) start sections; otherwise blank-line blocks are grouped up to ~1500 chars. Refs `§1..n`.
  - DOCX: `mammoth.convertToHtml` → walk `h1`–`h3`/`p`/`li` with `node-html-parser` → same numbering as markdown.
  - PPTX: `jszip`, slides `ppt/slides/slideN.xml` in numeric order; text = all `<a:t>` joined (paragraph `<a:p>` → newline); heading = first paragraph; ref `slide N`; empty slides are skipped.
  - PDF: `unpdf` `extractText(…, { mergePages: false })`; one section per page with ref `p.N`, heading null.
- Sample content requirements (fictional online shop, epic "Checkout Revamp"):
  - `requirements.md` with numbered headings, including **planted flaws**: §2.1 says guests can save a card for later; §3.2 says only logged-in users can save cards (*contradiction*); §1 says "checkout must be fast" with no target (*ambiguity*); no mention anywhere of payment timeout or failure handling (*gap*).
  - `design.md`: slides separated by `\n---\n`, 5 slides (architecture, checkout flow, payment provider, data model, notifications).
  - `api-spec.md`: 3 pages separated by `\f`.
  - `guidelines.md`: story format, AC as checklist, "every story gets a Sub-task 'QA: test <story>'", structure `Epic → Story → Sub-task`.
  - `routing.md`: teams Frontend (default **Linh Tran**), Backend (default **Bao Le**), QA (default **Mai Pham**), Payments (default **Quang Vo**); people with roles; ≥ 6 rules, one per line, e.g. `- Anything touching payments or cards → team Payments`, `- QA sub-tasks → team QA`, `- Database migrations → Bao Le`.
  - `fake-jira-project.json`: `{ projectMeta: ProjectMeta, users: AssignableUser[] }` (types from Task 6). Issue types Epic(level epic), Story(standard), Task(standard), Bug(standard), Sub-task(subtask). Users include the four default persons plus **Minh Nguyen** and **Minh Pham** (for the duplicate-name case) and **Nguyễn Văn An**.
  - `scripts/build-samples.ts`: (dev deps `docx pptxgenjs pdf-lib`) converts `requirements.md` → `.docx` (real Heading1–3 styles), `design.md` → `.pptx`, `api-spec.md` → `.pdf` (text drawn with a standard font; wrap long lines). npm script `"samples": "tsx scripts/build-samples.ts"`.

- [ ] **Step 1: Write the sample markdown files and the build script.** Run `npm i mammoth jszip unpdf node-html-parser` and `npm i -D docx pptxgenjs pdf-lib`, then `npm run samples` → three binary files exist.
- [ ] **Step 2: Write failing tests**

```ts
it('splits markdown into numbered sections', async () => {
  const d = await parseDocument('r.md', enc('# Intro\nhi\n## Scope\nx\n# Payments\ny'));
  expect(d.sections.map(s => s.ref)).toEqual(['r.md §1','r.md §1.1','r.md §2']);
});
it('parses the sample docx with heading refs', async () => {
  const d = await parseDocument('requirements.docx', read('samples/checkout-revamp/requirements.docx'));
  expect(d.sections.some(s => s.ref === 'requirements.docx §3.2' && /logged-in/i.test(s.text))).toBe(true);
});
it('parses the sample pptx one section per slide', async () => { expect((await parseDocument('design.pptx', read(...))).sections.map(s=>s.ref)).toEqual(['design.pptx slide 1', /* … */ 'design.pptx slide 5']); });
it('parses the sample pdf per page', async () => { expect((await parseDocument('api-spec.pdf', read(...))).sections).toHaveLength(3); });
it('rejects an empty txt naming the file', async () => { await expect(parseDocument('empty.txt', new Uint8Array())).rejects.toThrow(/empty\.txt.*file is empty/); });
it('rejects a textless pdf as possibly scanned', async () => { await expect(parseDocument('blank.pdf', await blankPdf())).rejects.toThrow(/no readable text/); });
it('rejects unsupported types', async () => { await expect(parseDocument('x.xlsx', enc('a'))).rejects.toThrow(DocumentParseError); });
```

- [ ] **Step 3: Run** `npx vitest run tests/core/ingest.test.ts` → FAIL.
- [ ] **Step 4: Implement** the parsers as specified.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(ingest): sample inputs and docx/pptx/pdf/md/txt section parsers`

---

### Task 5: LLM layer (provider-agnostic client, validated JSON, prompts, budget)

**Files:**
- Create: `src/core/llm/client.ts`, `structured.ts`, `budget.ts`, `prompts.ts`, `tests/helpers/fake-llm.ts`
- Test: `tests/core/llm.test.ts`

**Interfaces:**
- Produces:
  - `ChatMessage = { role: 'system'|'user'|'assistant'; content: string }`
  - `ProviderConfig = { baseUrl: string; apiKey: string; model: string; supportsJsonMode: boolean; contextTokens: number; temperature?: number }`
  - `interface LlmClient { readonly model: string; complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<string> }`
  - `createLlmClient(cfg: ProviderConfig): LlmClient`: `createOpenAICompatible({ name: 'custom', baseURL, apiKey })` + `generateText({ model: provider(cfg.model), messages, temperature })`. When `opts.json && cfg.supportsJsonMode`, pass `providerOptions: { custom: { response_format: { type: 'json_object' } } }` (or the SDK's equivalent at install time).
  - `extractJson(text: string): unknown`: strips ```` ```json ```` fences, else takes the substring from the first `{`/`[` to the matching last `}`/`]`, then `JSON.parse`. Throws `SyntaxError` on failure.
  - `generateValidated<T>(llm: LlmClient, schema: z.ZodType<T>, messages: ChatMessage[], opts?: { maxAttempts?: number /* default 3 */; step?: string }): Promise<T>`. On a parse or validation failure, append the assistant reply plus a user message `Your previous reply was invalid: <error summary ≤ 500 chars>. Reply with only valid JSON matching the schema.` and retry. After the last attempt, throw `LlmOutputError(step, attempts, lastErrorSummary)`. Each attempt is logged via `safeLog('llm.attempt', { step, attempt, status, model, durationMs })`, never content.
  - `estimateTokens(text: string): number` = `Math.ceil(text.length / 4)`; `checkContextBudget(parts: string[], contextTokens: number): { ok: boolean; estimated: number; limit: number }` with `limit = contextTokens - 8000`.
  - `renderPrompt(name: PromptName, vars: Record<string, string>): string` with `PromptName = 'structure'|'roster'|'clarify'|'draft'|'route'`. Reads `src/core/llm/prompts/<name>.md` (resolved from `process.cwd()`), replaces `{{var}}`, and throws if any `{{…}}` remains unreplaced. Prompt files are added by Tasks 9–13; this task adds `prompts/README.md` describing the convention.
  - `tests/helpers/fake-llm.ts`: `class FakeLlm implements LlmClient { model = 'fake'; calls: ChatMessage[][]; constructor(replies: (string | ((msgs: ChatMessage[]) => string))[]) }`. Replies are returned in order; it throws if they run out.

- [ ] **Step 1: Install** `npm i ai @ai-sdk/openai-compatible`.
- [ ] **Step 2: Write failing tests**

```ts
const S = z.object({ n: z.number() });
it('extracts JSON from fenced or chatty replies', () => {
  expect(extractJson('Sure!\n```json\n{"n":1}\n```')).toEqual({ n: 1 });
  expect(extractJson('Here: {"n":2} hope that helps')).toEqual({ n: 2 });
});
it('retries with the validation error, then succeeds', async () => {
  const llm = new FakeLlm(['{"n":"one"}', '{"n":1}']);
  await expect(generateValidated(llm, S, [{ role:'user', content:'go' }])).resolves.toEqual({ n: 1 });
  expect(llm.calls[1].at(-1)!.content).toMatch(/previous reply was invalid/);
});
it('throws LlmOutputError after 3 bad replies, including truncated JSON', async () => {
  await expect(generateValidated(new FakeLlm(['{"n":', 'nope', '{"n":"x"}']), S, [], { step: 'draft' })).rejects.toBeInstanceOf(LlmOutputError);
});
it('budget', () => expect(checkContextBudget(['a'.repeat(400_000)], 100_000)).toMatchObject({ ok: false, estimated: 100_000, limit: 92_000 }));
```

  `renderPrompt` takes an optional third parameter `dir?: string` so the test can point at `tests/fixtures/prompts/sample.md` containing `Hello {{name}}`. Test: `renderPrompt('sample' as any, { name: 'A' }, dir)` → `Hello A`; with `{}` → throws `/name/`.
- [ ] **Step 3: Run** `npx vitest run tests/core/llm.test.ts` → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS. `npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(llm): provider-agnostic client, validated JSON with retries, prompt rendering`

---

### Task 6: Ticketing adapter interface, fake adapter, ADF helpers

**Files:**
- Create: `src/core/ticketing/adapter.ts`, `tests/helpers/fake-ticketing.ts`, `src/integrations/jira/adf.ts`
- Test: `tests/integrations/adf.test.ts`, `tests/helpers/fake-ticketing.test.ts`

**Interfaces:**
- Produces (`adapter.ts`):
  - `IssueTypeMeta = { id: string; name: string; level: 'epic'|'standard'|'subtask'; requiredFields: { key: string; name: string }[] }`. Required fields exclude the ones the app always sets: `project, issuetype, summary, description, parent, assignee, labels, components, reporter`.
  - `ProjectMeta = { id: string; key: string; name: string; issueTypes: IssueTypeMeta[]; components: { id: string; name: string }[]; linkTypes: string[] }`
  - `AssignableUser = { accountId: string; displayName: string; email: string | null }`
  - `NewIssue = { clientRef: string /* draft item id */; projectKey: string; issueTypeId: string; summary: string; description: string; parentKey?: string; assigneeAccountId?: string; labels: string[]; componentIds?: string[]; fieldValues?: Record<string, unknown> }`
  - `CreateResult = { clientRef: string; ok: true; key: string } | { clientRef: string; ok: false; error: string }`
  - `interface TicketingAdapter { getProjectMeta(projectKey: string): Promise<ProjectMeta>; listAssignableUsers(projectKey: string): Promise<AssignableUser[]>; createIssues(issues: NewIssue[]): Promise<CreateResult[]>; findIssuesByLabel(projectKey: string, label: string): Promise<{ key: string; marker: string | null }[]>; linkIssues(fromKey: string, toKey: string, linkType: string): Promise<void>; getIssue(key: string): Promise<{ key: string; summary: string; level: 'epic'|'standard'|'subtask'; description: string } | null>; appendToDescription(key: string, text: string): Promise<void>; canBrowseProject(projectKey: string): Promise<boolean> }`
  - `MARKER_PREFIX = 'ai-backlog-item: '`; `markerFooter(itemId: string): string`; `readMarker(description: string): string | null` (from the last line starting with the prefix).
- Produces (`adf.ts`): `textToAdf(text: string): AdfDoc`. Supports `## ` headings (level 2/3), `- ` / `* ` bullet lists, `- [ ] ` items as bullets with a `☐ ` prefix, blank-line paragraphs. `adfToText(doc: AdfDoc): string` is the inverse for those nodes (other node types → their text content).
- Produces (`fake-ticketing.ts`): `class FakeTicketingAdapter implements TicketingAdapter`, constructed from `{ projectMeta, users }` (load `samples/fake-jira-project.json`). It stores issues in memory with keys `<KEY>-1…`. `issues: { key; issueTypeId; issueTypeName; summary; description; parentKey: string | null; labels: string[]; assigneeAccountId: string | null; componentIds: string[] }[]` and `links: { fromKey; toKey; linkType }[]` are inspectable. `failNext: Map<clientRef, string>` makes those creates fail. `failAfterCreate: Set<clientRef>` creates the issue but makes the call throw (simulates a crash before the key is saved). It validates that `assigneeAccountId` is among the users (else `{ok:false, error:'User cannot be assigned'}`) and that the parent exists.

- [ ] **Step 1: Write failing tests**

```ts
it('round-trips headings, bullets and checklist', () => {
  const t = '## Clarifications\n- Q1: guests? → No\n\nPara\n- [ ] AC one';
  expect(adfToText(textToAdf(t))).toBe('## Clarifications\n- Q1: guests? → No\n\nPara\n- ☐ AC one');
});
it('marker footer round-trips', () => expect(readMarker('body\n\n' + markerFooter('abc'))).toBe('abc'));
it('fake adapter rejects unknown assignee per item', async () => {
  const f = fakeFromSample(); const r = await f.createIssues([issue('a', { assigneeAccountId: 'nobody' }), issue('b')]);
  expect(r[0]).toMatchObject({ ok: false }); expect(r[1]).toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/integrations/adf.test.ts tests/helpers` → PASS.
- [ ] **Step 5: Commit** `feat(ticketing): adapter interface, ADF helpers and in-memory fake`

---

### Task 7: Jira Cloud adapter

**Files:**
- Create: `src/integrations/jira/client.ts`, `src/integrations/jira/adapter.ts`
- Test: `tests/integrations/jira-adapter.test.ts`

**Interfaces:**
- Consumes: `TicketingAdapter` and its types, `markerFooter/readMarker`, `textToAdf/adfToText` (Task 6).
- Produces:
  - `class JiraHttp { constructor(opts: { cloudId: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }) ; request<T>(method, path: string /* '/rest/api/3/…' */, body?): Promise<T> }`. Base `https://api.atlassian.com/ex/jira/${cloudId}`. On 401 it calls `getToken()` once more and retries once. It throws `JiraError(status, messages: string[])`, built from `errorMessages` + `errors` values.
  - `class JiraCloudAdapter implements TicketingAdapter { constructor(http: JiraHttp) }` using:
    - meta: `GET /rest/api/3/project/{key}` (id, name, components, `issueTypes[].hierarchyLevel`: 1→epic, 0→standard, -1→subtask), `GET /rest/api/3/issue/createmeta/{key}/issuetypes/{id}` (paginated `fields[]` with `required` + `hasDefaultValue`; required = `required && !hasDefaultValue` minus the always-set keys), `GET /rest/api/3/issueLinkType`.
    - users: `GET /rest/api/3/user/assignable/search?project={key}&maxResults=100&startAt=n` paged until fewer than 100 are returned; only `accountType === 'atlassian'`.
    - create: `POST /rest/api/3/issue/bulk` in chunks of **50**, fields `{ project:{key}, issuetype:{id}, summary, description: textToAdf(description), parent?:{key}, assignee?:{accountId}, labels, components?: [{id}], ...fieldValues }`. Map the response `issues[]` and `errors[]` (with `failedElementNumber`) back to `clientRef` order.
    - find: `POST /rest/api/3/search/jql` `{ jql: 'project = "KEY" AND labels = "LABEL"', fields: ['description'], maxResults: 100 }`, paging with `nextPageToken`; marker = `readMarker(adfToText(description))`.
    - link: `POST /rest/api/3/issueLink` `{ type:{name}, inwardIssue:{key: fromKey}, outwardIssue:{key: toKey} }`.
    - getIssue: `GET /rest/api/3/issue/{key}?fields=summary,issuetype,description` → 404 → null.
    - append: get the current description ADF, push `textToAdf(text).content` nodes, then `PUT /rest/api/3/issue/{key}` with the merged ADF (never replacing existing nodes).
    - canBrowse: `GET /rest/api/3/mypermissions?projectKey={key}&permissions=BROWSE_PROJECTS` → `permissions.BROWSE_PROJECTS.havePermission`; 404 → false.

- [ ] **Step 1: Write failing tests** with a fake `fetchImpl` that routes by method + path and returns canned JSON.

```ts
it('maps hierarchy levels and required fields', async () => { const m = await adapter.getProjectMeta('CHK'); expect(m.issueTypes.find(t=>t.name==='Sub-task')!.level).toBe('subtask'); expect(m.issueTypes.find(t=>t.name==='Story')!.requiredFields).toEqual([{ key:'customfield_10020', name:'Team' }]); });
it('chunks bulk create by 50 and maps partial errors to clientRef', async () => { const r = await adapter.createIssues(range(51).map(i => issue(`c${i}`))); expect(fetchCalls.filter(c => c.path.endsWith('/issue/bulk'))).toHaveLength(2); expect(r[3]).toEqual({ clientRef:'c3', ok:false, error: expect.stringContaining('assignee') }); });
it('retries once with a new token on 401', async () => { /* first call 401, second 200; getToken called twice */ });
it('appendToDescription keeps existing content', async () => { /* PUT body content = old nodes + new nodes */ });
it('findIssuesByLabel reads markers', async () => { expect(await adapter.findIssuesByLabel('CHK','ai-run-1234abcd')).toEqual([{ key:'CHK-9', marker:'item-1' }]); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/integrations` → PASS.
- [ ] **Step 5: Commit** `feat(jira): Jira Cloud adapter over REST v3`

---

### Task 9: Structure check

**Files:**
- Create: `src/core/pipeline/structure.ts`, `src/core/llm/prompts/structure.md`
- Test: `tests/core/structure.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `generateValidated`, `renderPrompt` (Task 5); `StructurePlan` (Task 3); `ProjectMeta` (Task 6).
- Produces:
  - `extractStructure(llm: LlmClient, guidelines: { filename: string; content: string }[]): Promise<StructurePlan>`. The prompt asks for the issue type names for the epic/story/task roles and a link type, or `specified:false` if the guidelines don't say. When `specified` is false, the result is replaced with the fallback `{ specified:false, epicType:'Epic', storyType:'Story', taskType:'Sub-task', taskLinkType:'Relates', notes:[FALLBACK_NOTICE] }`.
  - `FALLBACK_NOTICE` = the exact text from Global Constraints.
  - `ResolvedStructure = { plan: StructurePlan; epic: IssueTypeMeta; story: IssueTypeMeta; task: IssueTypeMeta; taskParent: 'story'|'epic' }`
  - `validateStructure(plan: StructurePlan, meta: ProjectMeta): { ok: true; resolved: ResolvedStructure; warnings: string[] } | { ok: false; errors: string[] }`. Type names match case-insensitively. Errors: type not found (`Guidelines ask for issue type "Test" but project CHK has none. Available: …`), epic type not epic-level, story type not standard-level. Task type subtask-level → `taskParent:'story'`; standard-level → `taskParent:'epic'` plus link, and a warning if `taskLinkType` isn't in `meta.linkTypes` (falls back to the first link type, or no link if there are none).

- [ ] **Step 1: Write failing tests**

```ts
it('falls back when guidelines are silent', async () => { const p = await extractStructure(new FakeLlm(['{"specified":false}']), [g]); expect(p.notes[0]).toBe(FALLBACK_NOTICE); expect(p.taskType).toBe('Sub-task'); });
it('errors on an unknown issue type with the available list', () => { const r = validateStructure({ ...plan, taskType:'Test' }, meta); expect(r.ok).toBe(false); expect((r as any).errors[0]).toMatch(/"Test".*Available: Epic, Story, Task, Bug, Sub-task/); });
it('standard-level task parents to epic and links to story', () => { const r = validateStructure({ ...plan, taskType:'Task' }, meta); expect(r.ok && r.resolved.taskParent).toBe('epic'); });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (the prompt includes the guideline text inside clear `<guideline file="…">` delimiters and the JSON shape). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): guideline structure extraction and Jira validation`

---

### Task 10: Routing file → roster, resolved to Jira users

**Files:**
- Create: `src/core/pipeline/roster.ts`, `src/core/llm/prompts/roster.md`
- Test: `tests/core/roster.test.ts`

**Interfaces:**
- Consumes: `Roster`, `RosterRule` (Task 3); `AssignableUser` (Task 6); LLM helpers (Task 5).
- Produces:
  - `parseRoster(llm, routingFile: { filename: string; content: string }): Promise<Roster>`. The prompt receives the file **with line numbers prefixed** (`12| …`). Rule ids are `R1..Rn` in file order; `quote` must be the rule text verbatim. After parsing, each `quote` is checked: it must appear on the cited `line` (whitespace-insensitive). Otherwise the line is corrected by searching the file, and the rule is dropped if the quote isn't found anywhere.
  - `normalizeName(s: string): string`: NFD, strip combining marks, `đ→d`, lowercase, collapse whitespace.
  - `ResolvedRoster = Roster & { accounts: Record<string /* normalized name */, AssignableUser>; unresolved: { name: string; reason: 'not_found'|'ambiguous'; suggestions: AssignableUser[] }[]; teamDefaults: Record<string /* team name */, AssignableUser | null> }`
  - `resolveRoster(roster: Roster, users: AssignableUser[]): ResolvedRoster`. For every name in people, team defaults, team members and person-targeted rules: an exact normalized match on displayName or email local part is accepted only if it's unique. More than one match → `ambiguous` with those users as suggestions. None → `not_found` with up to 3 suggestions by shared normalized tokens. A team whose default person is unresolved → `teamDefaults[team] = null`. A rule targeting an unknown team → an unresolved entry with reason `not_found` for that team name.

- [ ] **Step 1: Write failing tests** (users from `samples/fake-jira-project.json`)

```ts
it('matches ignoring diacritics', () => expect(resolveRoster(rosterWith(['Nguyen Van An']), users).accounts[normalizeName('Nguyen Van An')].displayName).toBe('Nguyễn Văn An'));
it('treats a name matching two users as ambiguous', () => { const r = resolveRoster(rosterWith(['Minh']), users); expect(r.unresolved).toEqual([expect.objectContaining({ name:'Minh', reason:'ambiguous', suggestions: expect.arrayContaining([expect.objectContaining({ displayName:'Minh Nguyen' }), expect.objectContaining({ displayName:'Minh Pham' })]) })]); });
it('first-name-only unique match is NOT accepted (must be exact full name)', ...);
it('drops a rule whose quote is not in the file and fixes a wrong line number', async () => { /* FakeLlm returns R1 with wrong line, R2 with invented quote */ });
it('null team default when the default person is unresolved', ...);
```

  Note: "Minh" matches no full display name exactly. Treat a query that equals the **first or last token** of several users as `ambiguous`, and of exactly one user as `not_found` with that user as the suggestion (never auto-accepted).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): routing file parsing and Jira user resolution`

---

### Task 11: Clarifying questions

**Files:**
- Create: `src/core/pipeline/clarify.ts`, `src/core/llm/prompts/clarify.md`
- Test: `tests/core/clarify.test.ts`

**Interfaces:**
- Consumes: `ParsedDocument`, `ClarifyingQuestion` (Task 3); LLM helpers (Task 5).
- Produces:
  - `PipelineInputs = { epicText: string; documents: ParsedDocument[]; guidelines: { filename: string; content: string }[] }`
  - `formatDocuments(docs: ParsedDocument[]): string`: each section rendered as `[<ref>] <heading>\n<text>`. Shared with Tasks 12–13.
  - `generateQuestions(llm, inputs: PipelineInputs): Promise<ClarifyingQuestion[]>`. The prompt asks only for contradictions, ambiguities and missing information that would change the breakdown, each with `sourceRefs` drawn from the given refs. Post-processing: drop refs not present in the inputs; sort by rank; keep at most **10**; renumber rank 1..n; assign `id` = `Q1..Qn`.
  - `formatClarifications(questions: ClarifyingQuestion[], resolutions: Record<string, Resolution>): string`: a `## Clarifications` heading, then one bullet per question: `- <text> → <answer>`, `→ Out of scope`, or `→ Left to judgment (see Assumption tickets)`.

- [ ] **Step 1: Write failing tests**

```ts
it('caps at 10, re-ranks and strips unknown refs', async () => {
  const reply = JSON.stringify({ questions: range(12).map(i => ({ category:'ambiguity', text:`q${i}`, sourceRefs:['requirements.md §1','bogus §9'], rank: 12 - i })) });
  const qs = await generateQuestions(new FakeLlm([reply]), inputs);
  expect(qs).toHaveLength(10); expect(qs[0]).toMatchObject({ id:'Q1', rank:1, text:'q11', sourceRefs:['requirements.md §1'] });
});
it('formats clarifications', () => expect(formatClarifications([q1,q2,q3], { Q1:{kind:'answered',answer:'No'}, Q2:{kind:'out_of_scope'}, Q3:{kind:'judgment'} })).toBe('## Clarifications\n- q1 → No\n- q2 → Out of scope\n- q3 → Left to judgment (see Assumption tickets)'));
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): clarifying questions`

---

### Task 12: Draft breakdown

**Files:**
- Create: `src/core/pipeline/draft.ts`, `src/core/llm/prompts/draft.md`
- Test: `tests/core/draft.test.ts`

**Interfaces:**
- Consumes: `PipelineInputs`, `formatDocuments`, `formatClarifications` (Task 11); `DraftItem`, `validateTree` (Task 3); `ResolvedStructure` (Task 9); LLM helpers (Task 5).
- Produces:
  - `generateDraft(llm, args: { inputs: PipelineInputs; questions: ClarifyingQuestion[]; resolutions: Record<string, Resolution>; structure: ResolvedStructure; newId?: () => string /* default crypto.randomUUID */ }): Promise<DraftItem[]>`
  - LLM output schema `DraftOutput = { epic: { title; description }, stories: { tempId; title; description; acceptanceCriteria: string[]; estimate?: number|null; sourceRefs: string[]; origin: 'from_docs'|'ai_suggestion'; assumptionQuestionIds: string[]; shapedBy: string[]; tasks: { title; description; acceptanceCriteria?: string[]; sourceRefs: string[]; origin; assumptionQuestionIds: string[]; shapedBy: string[] }[] }[] }`. Single call (builder's call; staged generation can be added later if output gets truncated).
  - Mapping rules: `assumption = assumptionQuestionIds` references any question resolved as `judgment`. Items whose sourceRefs only reference **out-of-scope** questions' refs are not removed (the prompt handles scope). `suggestionStatus = 'pending'` for `ai_suggestion`, else `null`. Unknown sourceRefs are dropped; `shapedBy` is limited to the provided guideline filenames. A `from_docs` item left with no valid sourceRefs becomes `origin:'ai_suggestion'` (no grounding → treated as a suggestion). The epic is `origin:'from_docs'`. Positions are in output order. The result passes `validateTree`.
  - The prompt includes: the guidelines (priority over defaults), structure role names, clarifications, "never invent requirements as from_docs; anything not grounded in a cited section is ai_suggestion", and the JSON shape.

- [ ] **Step 1: Write failing tests**

```ts
it('builds a valid tree with ids, flags and suggestion status', async () => {
  const items = await generateDraft(new FakeLlm([JSON.stringify(sampleDraftOutput)]), args);
  expect(() => validateTree(items)).not.toThrow();
  const timeout = items.find(i => i.title === 'Payment timeout handling')!;
  expect(timeout).toMatchObject({ origin:'ai_suggestion', suggestionStatus:'pending' });
});
it('marks assumption when it depends on a judgment question', ...);
it('downgrades ungrounded from_docs items to ai_suggestion', ...);
it('drops unknown refs and unknown shapedBy filenames', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): draft breakdown generation`

---

### Task 13: Routing tickets

**Files:**
- Create: `src/core/pipeline/route.ts`, `src/core/llm/prompts/route.md`
- Test: `tests/core/route.test.ts`

**Interfaces:**
- Consumes: `ResolvedRoster` (Task 10); `DraftItem`, `Routing` (Task 3); `ProjectMeta` (Task 6).
- Produces:
  - `routeItems(llm, args: { items: DraftItem[]; roster: ResolvedRoster }): Promise<DraftItem[]>`. Story and task items only (the epic keeps `routing:null`). One LLM call returns `{ assignments: { itemId; ruleId: string|null; reason: string }[] }`.
  - Deterministic resolution per item: `ruleId` null or unknown → `needs_decision`, reason `No routing rule matched`. Person target → the account if resolved, else `needs_decision` (`Rule R3 names "X", who isn't a resolved Jira user`). Team target → `teamDefaults[team]`, else `needs_decision` (`Team "Payments" has no resolved default person`). Assigned routing sets `teamName` (team target) and `ruleQuote`/`ruleLine` from the roster, never from the LLM. Items with `routing.overridden === true` are left unchanged. Items missing from the reply → `needs_decision`.
  - `componentIdsFor(item: DraftItem, meta: ProjectMeta): string[]` → the component whose name equals `routing.teamName` (case-insensitive), else `[]`.

- [ ] **Step 1: Write failing tests**

```ts
it('team rule assigns the default person with the verbatim quote', async () => { const out = await routeItems(new FakeLlm([JSON.stringify({ assignments:[{ itemId: story.id, ruleId:'R1', reason:'payments work' }] })]), { items, roster }); expect(out.find(i=>i.id===story.id)!.routing).toMatchObject({ status:'assigned', displayName:'Quang Vo', teamName:'Payments', ruleQuote: roster.rules[0].quote, ruleLine: roster.rules[0].line }); });
it('unknown rule id → needs_decision', ...);
it('leaves overridden routing untouched', ...);
it('item missing from reply → needs_decision', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): rule-based ticket routing with reasons`

---

### Task 14: Idempotent creation in the ticketing system

**Files:**
- Create: `src/core/pipeline/create.ts`
- Test: `tests/core/create.test.ts`

**Interfaces:**
- Consumes: `TicketingAdapter`, `NewIssue`, `markerFooter`, `readMarker` (Task 6); `ResolvedStructure` (Task 9); `activeItems`, `computeBlockers` (Task 3); `componentIdsFor` (Task 13).
- Produces:
  - `runLabel(runId: string): string` → `ai-run-${runId.slice(0, 8)}`
  - `createInTicketing(args: { adapter: TicketingAdapter; meta: ProjectMeta; projectKey: string; runId: string; items: DraftItem[]; structure: ResolvedStructure; existingEpicKey: string | null; clarificationsText: string; clarificationsWritten: boolean; acceptedByName: string; requiredFields: Record<ItemKind, { key; name }[]>; onItemCreated: (itemId: string, key: string) => Promise<void>; onItemFailed: (itemId: string, error: string) => Promise<void>; onClarificationsWritten: () => Promise<void> }): Promise<{ created: number; failed: number; skipped: number }>`
  - Algorithm, in order:
    1. If `computeBlockers` is non-empty → throw `CreateBlockedError(blockers)`.
    2. **Recover:** `findIssuesByLabel(projectKey, runLabel(runId))`. For each result whose marker equals an active item id without a `jiraKey` → `onItemCreated` (treated as created; counted in `skipped`).
    3. **Epic:** if `existingEpicKey` → the epic item gets that key (`onItemCreated`), and if `!clarificationsWritten && clarificationsText` → `appendToDescription(existingEpicKey, '\n' + clarificationsText)` then `onClarificationsWritten()`. Else, if the epic has no key → create it with description = `epic.description + '\n\n' + clarificationsText`.
    4. **Stories**, then **tasks**, each level in chunks via one `createIssues` call per level. Skip items with keys. A child whose parent has no key → `onItemFailed(id, 'Parent was not created')`. Task parent per `structure.taskParent` (`story` key or epic key). After creation, if `taskParent === 'epic'` → `linkIssues(taskKey, storyKey, structure.plan.taskLinkType)`.
    5. Each `NewIssue`: `clientRef = item.id`, labels `['ai-backlog', runLabel]` (+ `'ai-suggested'` for accepted suggestions), description = (suggestion prefix line + blank line, if a suggestion) + description + `\n\nAcceptance criteria:\n- [ ] …` (if any) + `\n\nSources: ref, ref` (if any) + `\n\n` + `markerFooter(item.id)`; assignee from routing; components via `componentIdsFor`; `fieldValues`.
    6. Rejected suggestions and their subtrees are never sent.
  - It never throws on per-item Jira errors (they go to `onItemFailed`). It rethrows adapter-level exceptions (network, auth) after recording nothing for the in-flight batch. The recovery step on the next attempt reconciles.

- [ ] **Step 1: Write failing tests** (`FakeTicketingAdapter`, sample meta, an in-memory map as the "DB" for callbacks)

```ts
it('creates epic → stories → sub-tasks with labels, assignee and marker', async () => {
  await createInTicketing(args);
  const story = fake.issues.find(i => i.summary === 'Save card for later')!;
  expect(story.parentKey).toBe(fake.issues.find(i => i.issueTypeName === 'Epic')!.key);
  expect(story.labels).toEqual(['ai-backlog', `ai-run-${runId.slice(0,8)}`]);
  expect(readMarker(story.description)).toBe(storyItem.id);
});
it('labels accepted suggestions and prefixes the description', ...  /* 'Proposed by AI and accepted by Linh Tran.' */);
it('one failed item does not stop others; retry creates only the failed one', async () => {
  fake.failNext.set(taskA.id, 'User cannot be assigned');
  await createInTicketing(args); expect(errors[taskA.id]).toMatch(/cannot be assigned/);
  const before = fake.issues.length; await createInTicketing(argsWithSavedKeys());
  expect(fake.issues.length).toBe(before + 1);
});
it('no duplicates when the process crashed after Jira created the issue', async () => {
  fake.failAfterCreate.add(storyItem.id);
  await expect(createInTicketing(args)).rejects.toThrow();
  await createInTicketing(argsWithSavedKeys());
  expect(fake.issues.filter(i => i.summary === storyItem.title)).toHaveLength(1);
});
it('appends clarifications to an existing epic exactly once', ...);
it('standard-level tasks parent to the epic and link to their story', ...);
it('throws CreateBlockedError while blockers exist', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/core` → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): idempotent, crash-safe ticket creation`

---

### Task 15: Persistence, provider profiles and the run service

**Files:**
- Create: `src/server/providers.ts`, `src/server/projects.ts`, `src/server/runs/repo.ts`, `src/server/runs/service.ts`
- Test: `tests/server/run-service.test.ts`, `tests/server/providers.test.ts`

**Interfaces:**
- Consumes: everything in `src/core` (Tasks 3–14), `Db` (Task 2), crypto (Task 1).
- Produces:
  - `providers.ts`: `createProfile(db, ownerUserId, input: { name; baseUrl; apiKey; model; supportsJsonMode; contextTokens }): Promise<ProfileView>`; `listProfiles(db, ownerUserId): Promise<ProfileView[]>`; `ProfileView = { id; name; baseUrl; model; supportsJsonMode; contextTokens; apiKeyMasked: string }` (never the key); `resolveProviderConfig(db, project): Promise<ProviderConfig>`. Order: the project's profile (decrypted); else the env default (`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`, `supportsJsonMode:false`, `contextTokens: LLM_CONTEXT_TOKENS`); else throw `NoProviderError`. `describeProvider(db, project): Promise<{ source: 'profile'|'env'; name: string; model: string; baseUrlHost: string }>` for the UI.
  - `projects.ts`: `createProject(db, owner, { name, cloudId, siteUrl, jiraProjectKey }): Promise<Project>`; `getProject(db, id)`; `listProjectsForSites(db, cloudIds: string[])`; `setProjectProvider(db, projectId, profileId | null)`; `setRetentionDays(db, projectId, days)`; `uploadProjectFile(db, projectId, userId, kind: 'guideline'|'routing', filename, content): Promise<ProjectFile>` (sha256; a new version deactivates the previous active file with the same filename and kind; a routing upload deactivates **all** previous routing files, since there's one active routing file); `removeProjectFile(db, fileId)` (sets inactive); `activeFiles(db, projectId)`.
  - `runs/repo.ts`: CRUD used by the service; `touch(runId)` sets `lastActivityAt`; draft items saved via full replace in one transaction: `saveDraft(db, runId, items)`; `loadDraft(db, runId): Promise<DraftItem[]>` ordered by parent then position.
  - `runs/service.ts`:

```ts
type RunDeps = { db: Db; llmFor: (project: Project) => Promise<LlmClient>; adapterFor: (userId: string, project: Project) => Promise<TicketingAdapter> };
class RunService {
  constructor(deps: RunDeps);
  createRun(userId, projectId, input: { epicText: string; existingEpicKey: string | null }): Promise<Run>;   // status 'inputs'; records active file versions
  addDocument(runId, filename, bytes: Uint8Array): Promise<RunDocumentView>;      // parseDocument; DocumentParseError surfaces as-is
  removeDocument(runId, docId): Promise<void>;
  runChecks(userId, runId): Promise<ChecksResult>;    // budget check, getProjectMeta, extractStructure+validateStructure, parseRoster+resolveRoster, existing epic must exist & be epic-level; stores structure/roster; status 'checked' when ok
  generateQuestions(runId): Promise<ClarifyingQuestion[]>;  // status 'questions' (or straight to draft if none)
  resolveQuestion(runId, questionId, resolution: Resolution): Promise<void>;
  generateDraft(runId): Promise<DraftItem[]>;          // requires every question resolved; draft + route; status 'review'; refuses if any item has jiraKey
  editDraft(runId, op: DraftOp): Promise<DraftItem[]>; // applies tree.ts op, saves; refuses structural ops on items with jiraKey
  getReview(runId): Promise<{ items: DraftItem[]; blockers: Blocker[]; requiredFields; provider; existingEpic: { key; summary } | null; clarificationsPreview: string }>;
  createTickets(userId, runId): Promise<{ created; failed; skipped }>;  // status 'creating' then 'done' when every active item has a key
}
type ChecksResult = { ok: boolean; budget: { estimated; limit; ok }; structure: { errors: string[]; warnings: string[]; notes: string[] }; roster: { teams; people; rules; unresolved }; existingEpicError: string | null };
type DraftOp = { type:'add'; parentId; kind; title } | { type:'delete'; id } | { type:'move'; id; newParentId } | { type:'update'; id; patch } | { type:'suggestion'; id; status:'accepted'|'rejected' } | { type:'route'; id; accountId: string };   // 'route' looks up displayName in the run's assignable users
```

  `requiredFields` per kind comes from the resolved structure's issue types. `acceptedByName` for creation = the creating user's displayName. Every service method calls `touch`.

- [ ] **Step 1: Write failing tests**

```ts
it('full greenfield run: checks → questions → draft → edit → create', async () => {
  const fake = fakeFromSample();
  const llm = new FakeLlm([structureReply, rosterReply, questionsReply, draftReply, routeReply]);
  const svc = new RunService({ db, llmFor: async () => llm, adapterFor: async () => fake });
  // upload guideline + routing via projects.ts; create run; add the three sample binaries + md
  expect((await svc.runChecks(u.id, run.id)).ok).toBe(true);
  const qs = await svc.generateQuestions(run.id); for (const q of qs) await svc.resolveQuestion(run.id, q.id, { kind:'judgment' });
  await svc.generateDraft(run.id);
  let review = await svc.getReview(run.id); expect(review.blockers.length).toBeGreaterThan(0);
  for (const b of review.blockers) { /* accept suggestions, route needs_decision to Bao Le */ }
  expect((await svc.getReview(run.id)).blockers).toEqual([]);
  const res = await svc.createTickets(u.id, run.id);
  expect(res.failed).toBe(0); expect(fake.issues.length).toBe(res.created);
});
it('generateDraft refuses while questions are unresolved', ...);
it('runChecks reports over-budget documents without calling the LLM', ...);
it('runChecks reports an existing epic key that is not an epic', ...);
it('routing upload deactivates the previous routing file', ...);
// providers.test.ts
it('never returns the api key and masks it', ...); it('falls back to env profile', ...); it('throws NoProviderError when nothing configured', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `feat(server): persistence, provider profiles and run orchestration`

---

### Task 16: Atlassian sign-in, sessions, token refresh, access control

**Files:**
- Create: `src/server/auth/atlassian.ts`, `src/server/auth/session.ts`, `src/server/auth/tokens.ts`, `src/server/access.ts`, `src/app/api/auth/login/route.ts`, `src/app/api/auth/callback/atlassian/route.ts`, `src/app/api/auth/logout/route.ts`, `src/server/deps.ts`
- Test: `tests/server/auth.test.ts`, `tests/server/access.test.ts`

**Interfaces:**
- Consumes: `getEnv`, crypto (Task 1); `Db`, `users` (Task 2); `JiraHttp`, `JiraCloudAdapter` (Task 7); `RunDeps` (Task 15).
- Produces:
  - `atlassian.ts` (all take an optional `fetchImpl`): `buildAuthorizeUrl(state: string): string` (`https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=…&scope=<scopes>&redirect_uri=<APP_URL>/api/auth/callback/atlassian&state=…&response_type=code&prompt=consent`); `exchangeCode(code): Promise<TokenSet>`; `refresh(refreshToken): Promise<TokenSet>`; `TokenSet = { accessToken; refreshToken; expiresAt: Date }`; `getMe(token): Promise<{ accountId; name; email: string | null }>` (`https://api.atlassian.com/me`); `getSites(token): Promise<{ cloudId; name; url }[]>` (`/oauth/token/accessible-resources`).
  - `session.ts`: iron-session cookie `ebc_session` `{ userId?: string; oauthState?: string }`, password `SESSION_SECRET`, `httpOnly`, `sameSite: 'lax'`, `secure` when APP_URL is https. `getSession()`, `requireUser(): Promise<User>` (throws `UnauthorizedError`).
  - `tokens.ts`: `getValidAccessToken(db, userId, opts?: { fetchImpl?; now?: () => Date }): Promise<string>`. Refreshes when it expires within 60 s, then saves **both** new tokens encrypted (Atlassian rotates refresh tokens). On a refresh failure with 400/401 (`invalid_grant`) → throws `ReauthRequiredError`.
  - `access.ts`: `canAccessProject(db, userId, project): Promise<boolean>` via `JiraCloudAdapter.canBrowseProject`, cached in-memory per `(userId, projectId)` for **5 minutes**; `assertProjectAccess(...)` throws `ForbiddenError`; `assertOwner(user, project)` throws `ForbiddenError` unless `project.ownerUserId === user.id`.
  - `deps.ts`: `runDeps(): Promise<RunDeps>`: the real `llmFor` (createLlmClient(resolveProviderConfig)) and `adapterFor` (JiraHttp with `getToken = () => getValidAccessToken(db, userId)`). `RunService` is constructed per request.
  - Login route: generates `state`, stores it in the session, redirects. Callback: verifies `state`, exchanges the code, upserts the user (tokens encrypted), sets `userId`, redirects `/projects`. Logout: destroys the session, redirects `/`.

- [ ] **Step 1: Write failing tests**

```ts
it('refreshes an expiring token and stores the rotated refresh token', async () => { /* user with expiresAt now+30s; fetch returns new tokens */ const t = await getValidAccessToken(db, u.id, { fetchImpl }); expect(t).toBe('new-access'); expect(decryptSecret((await getUser(db,u.id)).refreshTokenEnc)).toBe('new-refresh'); });
it('does not refresh a token valid for 10 minutes', ...);
it('throws ReauthRequiredError when refresh is rejected (invalid_grant)', ...);
it('authorize URL carries scopes, callback and state', () => { const u = new URL(buildAuthorizeUrl('s1')); expect(u.searchParams.get('scope')).toBe('read:jira-work write:jira-work read:jira-user read:me offline_access'); expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback/atlassian'); });
// access.test.ts
it('caches browse permission for 5 minutes', async () => { /* adapter spy called once for two checks, again after now+301s */ });
it('assertOwner rejects non-owners', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** `npm i iron-session`, then implement. **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `feat(auth): Atlassian OAuth sign-in, token refresh and project access checks`

---

### Task 17: API routes

**Files:**
- Create: `src/app/api/sites/route.ts`, `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/route.ts`, `src/app/api/projects/[id]/files/route.ts`, `src/app/api/projects/[id]/files/[fileId]/route.ts`, `src/app/api/sites/[cloudId]/projects/route.ts`, `src/app/api/providers/route.ts`, `src/app/api/projects/[id]/runs/route.ts`, `src/app/api/runs/[id]/route.ts`, `src/app/api/runs/[id]/documents/route.ts`, `src/app/api/runs/[id]/documents/[docId]/route.ts`, `src/app/api/runs/[id]/checks/route.ts`, `src/app/api/runs/[id]/questions/route.ts`, `src/app/api/runs/[id]/questions/[qid]/route.ts`, `src/app/api/runs/[id]/draft/route.ts`, `src/app/api/runs/[id]/create/route.ts`, `src/server/http.ts`
- Test: `tests/app/api.test.ts`

**Interfaces:**
- Consumes: `RunService`, repos (Task 15); auth/access/deps (Task 16).
- Produces:
  - `src/server/http.ts`: `handle(fn: () => Promise<unknown>): Promise<Response>`. Maps errors to JSON `{ error: { code, message } }`: `UnauthorizedError` 401 `unauthorized`; `ReauthRequiredError` 401 `reauth_required`; `ForbiddenError` 403; `DocumentParseError` 422 `parse_error`; `TreeError` 422 `invalid_edit`; `CreateBlockedError` 409 `blocked` (+ `blockers`); `LlmOutputError` 502 `llm_output` ("The AI returned an unusable answer after 3 tries. Try again or switch model."); `NoProviderError` 409 `no_provider`; `JiraError` 502 `jira` (+ Jira messages); anything else 500 `internal` (logged with `safeLog`, no content).
  - Routes (all require a user; project-scoped routes call `assertProjectAccess`; provider/retention/delete call `assertOwner`):
    - `GET /api/sites` → the user's Atlassian sites. `GET /api/sites/[cloudId]/projects` → Jira projects the user can browse (`GET /rest/api/3/project/search`). *(Add `listProjects()` to `JiraCloudAdapter` as a Jira-only method; it isn't part of `TicketingAdapter`.)*
    - `GET/POST /api/projects`: list projects on the user's sites that they can access / create one.
    - `GET/PATCH/DELETE /api/projects/[id]`: PATCH `{ providerProfileId?, retentionDays? }` (owner only).
    - `GET/POST /api/projects/[id]/files` (multipart: `kind`, `file`; .md/.txt only, ≤ 200 KB), `DELETE …/files/[fileId]`.
    - `GET/POST /api/providers` (POST body `{ name, baseUrl, apiKey, model, supportsJsonMode, contextTokens }`).
    - `POST /api/projects/[id]/runs` `{ epicText, existingEpicKey? }`; `GET /api/runs/[id]` (run + documents + checks + questions + status).
    - `POST /api/runs/[id]/documents` (multipart, ≤ 20 MB per file), `DELETE …/documents/[docId]`.
    - `POST /api/runs/[id]/checks`; `POST /api/runs/[id]/questions` (generate); `PUT /api/runs/[id]/questions/[qid]` (`Resolution` body).
    - `POST /api/runs/[id]/draft` (generate/regenerate); `GET /api/runs/[id]/draft` (= `getReview`); `PATCH /api/runs/[id]/draft` (`DraftOp` body, validated by zod).
    - `POST /api/runs/[id]/create`.
  - Long-running routes set `export const maxDuration = 300` and `export const runtime = 'nodejs'`.

- [ ] **Step 1: Write failing tests** for `handle` and two representative routes, calling the exported handlers directly with `new Request(...)`. Mock `requireUser`/`runDeps` with `vi.mock`.

```ts
it('maps CreateBlockedError to 409 with blockers', async () => { const r = await handle(async () => { throw new CreateBlockedError([b]); }); expect(r.status).toBe(409); expect((await r.json()).error.blockers).toHaveLength(1); });
it('maps ReauthRequiredError to 401 reauth_required', ...);
it('PATCH draft rejects an invalid op body with 400', ...);
it('PATCH project provider by non-owner → 403', ...);
it('500 responses never include the thrown message', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/app` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(api): route handlers for projects, files, providers and runs`

---

### Task 18: UI: shell, projects, settings, routing check

**Files:**
- Create: `src/app/page.tsx` (replace), `src/app/projects/page.tsx`, `src/app/projects/new/page.tsx`, `src/app/projects/[id]/page.tsx`, `src/app/settings/providers/page.tsx`, `src/components/AppShell.tsx`, `src/components/FileList.tsx`, `src/components/ProviderBadge.tsx`, `src/lib/api.ts` (client fetch helper)
- Test: `tests/ui/provider-badge.test.tsx`, `tests/ui/api-client.test.ts`

**Interfaces:**
- Consumes: API routes (Task 17).
- Produces:
  - `apiFetch<T>(path, init?): Promise<T>`: throws `ApiError(code, message, details)`. On `reauth_required` or `unauthorized` it redirects to `/api/auth/login`, after saving nothing (drafts are server-side already).
  - `/`: "Sign in with Atlassian" button (→ `/api/auth/login`), or a redirect to `/projects` when signed in.
  - `/projects`: list of projects (name, Jira key, site, ProviderBadge) + "New project".
  - `/projects/new`: pick a site → pick a Jira project → name → create.
  - `/projects/[id]`: sections **Guideline files** (upload .md/.txt, list with version + uploaded date, remove; link "Download starter template"), **Routing file** (one active; upload/replace), **AI provider** (owner: select profile; others: read-only), **Retention days** (owner), "Start a new breakdown" button. The starter templates are served from `public/templates/guidelines-template.md` and `public/templates/routing-template.md` (create them: sections Story format, Acceptance criteria style, Sizing, Standard tasks per story, **Ticket structure**; routing: Teams (name, default person, members), People, Rules one per line).
  - `/settings/providers`: list profiles (masked key) and an add form. Help text names example base URLs (OpenAI `https://api.openai.com/v1`, Ollama `http://localhost:11434/v1`, OpenRouter).
  - `ProviderBadge({ provider: { source, name, model, baseUrlHost } })`: renders `"<name> · <model> (<host>)"`; when the host isn't `localhost`/`127.0.0.1`, it shows a "cloud" marker so nobody sends confidential docs to a cloud model by mistake.
  - Styling: Tailwind, neutral palette, readable at 1280 px and usable at 768 px.

- [ ] **Step 1: Write failing tests**

```ts
it('ProviderBadge marks cloud hosts', () => { render(<ProviderBadge provider={{ source:'profile', name:'OpenAI', model:'gpt-x', baseUrlHost:'api.openai.com' }} />); expect(screen.getByText(/cloud/i)).toBeInTheDocument(); });
it('ProviderBadge does not mark localhost', ...);
it('apiFetch throws ApiError with server code', ...);
```

  (UI tests use `// @vitest-environment jsdom` and `@testing-library/jest-dom`.)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the pages. **Step 4: Run** tests → PASS; `npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(ui): sign-in, projects, files, provider settings`

---

### Task 19: UI: run flow (inputs, checks, questions)

**Files:**
- Create: `src/app/runs/new/page.tsx` (query `?project=`), `src/app/runs/[id]/page.tsx`, `src/components/run/Stepper.tsx`, `src/components/run/InputsStep.tsx`, `src/components/run/ChecksStep.tsx`, `src/components/run/QuestionsStep.tsx`, `src/components/run/ExtractedTextDialog.tsx`
- Test: `tests/ui/questions-step.test.tsx`, `tests/ui/checks-step.test.tsx`

**Interfaces:**
- Consumes: API routes (Task 17); `ProviderBadge` (Task 18).
- Produces:
  - `/runs/[id]` shows a stepper `Inputs → Checks → Questions → Review → Done` driven by `run.status`. Review/Done are rendered by Task 20's component (imported from `src/components/review/ReviewScreen.tsx`; until Task 20 exists, a placeholder file exporting `ReviewScreen` that renders "Review coming soon" is created here and replaced in Task 20).
  - **InputsStep:** epic text area; optional "Add to existing epic" key field; multi-file upload (DOCX/PPTX/PDF/TXT/MD) with per-file status and parse errors shown inline (message from the API); "View extracted text" per document opens `ExtractedTextDialog` (section refs + text); the project's active guideline and routing files listed read-only; ProviderBadge; "Run checks" button.
  - **ChecksStep:** budget (estimated vs limit; over → red error "Too much text for this model…", with a hint to remove documents); structure errors (block), warnings and notes (fallback notice); **routing check** tables: teams (name, default person → resolved user or ⚠), people, rules (id, line, quote, target); unresolved names with reason and suggestions. Any error disables "Continue" and offers "Re-run checks" (after fixing files on the project page; link provided).
  - **QuestionsStep:** "Generate questions" (spinner while running). Each question card: category chip, text, source refs, then three choices: an **Answer** text box, **Out of scope**, **Use your judgment**. Saved on change. "Generate draft" is enabled only when every question is resolved. If there are zero questions, show "No open questions found" and the "Generate draft" button.
  - Long requests show a spinner with the step name; errors show the API message and a Retry.

- [ ] **Step 1: Write failing tests**

```ts
it('Generate draft is disabled until every question is resolved', async () => { render(<QuestionsStep run={runWith([q1,q2])} … />); expect(screen.getByRole('button', { name:/generate draft/i })).toBeDisabled(); await user.click(screen.getAllByRole('button', { name:/out of scope/i })[0]); await user.click(screen.getAllByRole('button', { name:/use your judgment/i })[1]); expect(screen.getByRole('button', { name:/generate draft/i })).toBeEnabled(); });
it('ChecksStep shows ambiguous routing names with suggestions and blocks Continue', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`npm i -D @testing-library/user-event`). **Step 4: Run** → PASS; `npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(ui): run inputs, checks and clarifying questions`

---

### Task 20: UI: review screen (layout A) and creation results

**Files:**
- Create/replace: `src/components/review/ReviewScreen.tsx`, `src/components/review/Tree.tsx`, `src/components/review/DetailPanel.tsx`, `src/components/review/TopBar.tsx`, `src/components/review/BlockerList.tsx`, `src/components/review/Tags.tsx`
- Test: `tests/ui/review.test.tsx`

**Interfaces:**
- Consumes: `GET/PATCH/POST /api/runs/[id]/draft`, `POST /api/runs/[id]/create` (Task 17); `DraftItem`, `Blocker` (Task 3). Visual reference: `.superpowers/mockups/review-layout-v2.html` (a local file; describe from this plan if it's missing).
- Produces:
  - **Tree (left, ~45%)**: nested epic → stories → tasks, indented. Each row: **title first, then tags**: a type tag (`EPIC`/`STORY`/`TASK` coloured), `AI suggestion` (dashed yellow), `Assumption`, `Needs decision` (red), and the Jira key link after creation (`<siteUrl>/browse/<KEY>`). AI-suggestion rows show inline **✓ Accept** / **✕ Reject**; a rejected row is struck through and greyed with its subtree (with an "Undo" that sets it back to `accepted`). Row actions: add child, delete (with confirm), move via a "Move to…" parent picker. Clicking a row selects it.
  - **DetailPanel (right)**: editable title, description (textarea), acceptance criteria (list editor), estimate, required field inputs (`requiredFields[kind]`, plain text inputs). Source refs listed. **Routing**: assignee name, reason, quoted rule with `routing.md line N`, and a **Change** select listing assignable users (→ `route` op). "Shaped by: …". Edits are saved on blur via PATCH (debounced 500 ms for text).
  - **TopBar**: run/epic title + counts (`1 epic · N stories · M tasks`), **Regenerate** (only when no item has a jiraKey; confirm text: "Regenerate replaces the whole draft. Your edits, Accept/Reject decisions and routing changes will be lost. Clarification answers are kept."), **Filter: AI suggestions** toggle, blocker count chip (click → BlockerList popover; clicking a blocker selects that item), **Create N tickets in Jira** (N = active items without key; disabled while blockers > 0).
  - **Existing epic preview**: when `existingEpic` is set, a panel above the tree: "Will append to <KEY> <summary>:" + `clarificationsPreview` + "and add N child tickets. Existing text and children are not changed."
  - **After Create**: items show keys; failed items show a red error line with the Jira reason; the TopBar button becomes **Retry failed (K)**; when everything is created, status Done with a "View epic in Jira" link.

- [ ] **Step 1: Write failing tests**

```ts
it('renders title before tags', () => { render(<Tree items={items} … />); const row = screen.getByTestId(`row-${story.id}`); expect(row.textContent!.indexOf(story.title)).toBeLessThan(row.textContent!.indexOf('STORY')); });
it('Create is disabled while blockers exist and shows the count', ...);
it('Accept on an AI suggestion sends a suggestion op', async () => { /* mock fetch; click ✓ Accept; expect PATCH body {type:'suggestion', id, status:'accepted'} */ });
it('Regenerate is hidden once any item has a Jira key', ...);
it('failed items show the Jira error and the button becomes Retry failed', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/ui` → PASS; `npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(ui): review screen with tree, detail panel and Jira creation`

---

### Task 21: Retention purge

**Files:**
- Create: `src/server/retention.ts`, `src/instrumentation.ts`
- Test: `tests/server/retention.test.ts`

**Interfaces:**
- Consumes: `Db`, tables (Task 2).
- Produces:
  - `purgeExpired(db: Db, now: Date): Promise<{ documentsPurged: number }>`. For each run with `completedAt` older than the project's `retentionDays`, or with **no activity** (`lastActivityAt`) for `retentionDays`: set `runDocuments.sections = null`, `deletedAt = now` for documents not yet purged. Also clear `runs.epicText` to `''` for those runs only when status is `done`. Guideline/routing project files are project configuration and are **not** purged. Logs `safeLog('retention.purge', { count })`.
  - `startRetentionLoop(getDb: () => Promise<Db>): void`: runs once immediately, then every 60 min (`setInterval(...).unref()`). It only ever starts once (module-level guard).
  - `src/instrumentation.ts`: `export async function register() { if (process.env.NEXT_RUNTIME === 'nodejs') { const { startRetentionLoop } = await import('./server/retention'); const { getDb } = await import('./server/db/client'); startRetentionLoop(getDb); } }`
  - The run service (Task 15) and the API return `410`-style messaging for purged documents: `ExtractedTextDialog` shows "Deleted by retention policy".

- [ ] **Step 1: Write failing tests**

```ts
it('purges documents of runs done longer than retention ago', async () => { /* run completedAt = now - 8d, retention 7 → sections null */ });
it('purges abandoned runs by lastActivityAt', ...);
it('keeps recent runs and never touches project files', ...);
it('respects per-project retentionDays', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): document retention purge`

---

### Task 22: Evaluation script, README, live smoke checklist

**Files:**
- Create: `scripts/eval.ts`, `README.md`, `docs/smoke-test.md`
- Test: `tests/scripts/eval.test.ts`

**Interfaces:**
- Consumes: pipeline functions (Tasks 9–13), `parseDocument` (Task 4), `createLlmClient` (Task 5), `FakeTicketingAdapter` + sample JSON (Task 6), `createInTicketing` (Task 14).
- Produces:
  - `evaluate(llm: LlmClient, sampleDir: string): Promise<EvalReport>` exported from `scripts/eval.ts`. `EvalReport = { model; steps: { name; ok; durationMs; error?: string }[]; questions: number; plantedFlawsFound: { contradiction: boolean; ambiguity: boolean; gap: boolean }; items: { stories; tasks; suggestions }; routing: { assigned; needsDecision }; created: number }`. Planted-flaw detection: a question whose sourceRefs include `requirements.* §2.1` or `§3.2` with category contradiction; one citing `§1` with ambiguity; one whose text matches `/timeout|fail/i` with category missing. It runs the full pipeline, resolving all questions as `judgment`, accepting all suggestions, routing `needs_decision` items to the QA default, and creating into the fake adapter.
  - CLI: `npm run eval` (`tsx scripts/eval.ts`) reads `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` (optional `--profile-json path`), prints a table plus JSON to `./.data/eval-<model>-<timestamp>.json`. No document content is printed.
  - `README.md`: what it is; prerequisites (Node 24); setup (`npm i`, copy `.env.example` → `.env.local`, generate secrets, **create a Jira Cloud test site + OAuth 2.0 (3LO) app with the callback URL and scopes from Global Constraints**, `npm run dev`); the AI provider setup including Ollama; `npm test`, `npm run samples`, `npm run eval`; optional Postgres via `docker compose up -d` + `DATABASE_URL`.
  - `docs/smoke-test.md`: the live end-to-end checklist matching spec §2 steps 1–9, including switching provider and re-running, and checking in Jira: hierarchy, assignees, labels, `ai-suggested`, clarifications on the epic, no duplicates after a forced retry.

- [ ] **Step 1: Write failing test**: `evaluate(new FakeLlm([...recorded replies...]), 'samples/checkout-revamp')` → `plantedFlawsFound` all true, `created === items.stories + items.tasks + 1`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** plus the docs. **Step 4: Run** `npm test && npm run typecheck && npm run build` → all PASS.
- [ ] **Step 5: Commit** `feat: evaluation harness, README and live smoke-test checklist`

---

## Self-review notes

- Spec coverage: §2 steps 1–9 → Tasks 16, 18, 19, 9–10, 11, 12, 13, 20, 14, 18 (provider switch) and 22 (smoke). §6.3 → 4; §6.4 → 9; §6.5 → 10 + 19; §6.6 → 11 + 19; §6.7 → 12; §6.8 → 13; §6.9 → 20; §6.10 → 14; §6.11 → 5 + 15 + 18; §6.12 → 6–7; §6.13 → 1, 16, 18 (badge), 21; §7 → 2; §8 → 4 + 22; §9 → all tasks + 22.
- Task numbers skip 8 (an earlier draft's task was folded into Task 6). Numbers are kept as-is so cross-references stay stable.
- Deviations from the spec (builder's calls): PGlite as the default local database (Docker isn't installed); Team-field support reduced to **components only** (the Jira Team field needs Atlassian Teams IDs, so it's deferred); single-call draft generation.
