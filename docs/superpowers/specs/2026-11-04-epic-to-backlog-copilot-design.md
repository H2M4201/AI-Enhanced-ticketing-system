# Epic-to-Backlog Copilot — Design

*AI-Enhanced Ticketing System, Team A. Design date: 2026-11-04.*

Markers used below:
- **[Decided]**: the product owner decided this in the design conversation.
- **[Builder's call]**: chosen by the designer (Claude). It can be changed without asking, but the change should be noted.
- **[Guess]**: an assumption the product owner has not confirmed yet.

---

## 1. Intent and why

PMs and BAs on software projects start from requirement documents and high-level system design documents. Today they:
1. break those docs down into epics, user stories and tasks by hand,
2. type every one of them into Jira by hand, and
3. decide by hand who each ticket goes to (devs, testers, …).

Step 2 in particular is slow, repetitive admin. This tool takes **an epic description + reference docs + guideline files + a routing rule file** and produces a **reviewed, routed set of real Jira tickets**. Along the way, the AI improves the requirements: it asks the PM/BA about vague or contradictory spots before drafting, and proposes stories or edge cases they may have missed.

**What this build is:** an **internal demo** that runs the whole flow for real, built on foundations that can grow into a production tool. Demo-only shortcuts that would have to be torn out later are not acceptable.

**Who builds it:** Claude, alone, through a written plan and subagent-driven development. **[Decided]**

**Target user:** PM / BA. The tickets it creates serve the whole project team (devs, testers, …).

---

## 2. Goals: what the demo must show live, end to end

1. The PM/BA signs in with their Atlassian account and picks a Jira Cloud project.
2. They upload an **epic description** (typed or pasted), **reference docs**, **guideline files** and a **routing rule file**.
3. The app checks that the ticket structure the guidelines ask for exists in that Jira project. Problems are shown before any AI drafting.
4. The AI asks **clarifying questions** about vague, missing or contradictory points; the PM/BA answers.
5. The AI drafts the **breakdown tree**: epic → stories → tasks/sub-tasks, each with description, acceptance criteria and a source reference. AI-proposed extras are marked.
6. Every ticket gets a proposed **assignee with a reason** quoting the routing rule used. Unmatched tickets are flagged.
7. The PM/BA reviews and edits in the review screen, accepts or rejects AI suggestions, fixes routing, then clicks **Create**.
8. Real tickets appear in **real Jira** with the correct hierarchy, fields and assignees. Each tree item shows its Jira key as a link.
9. The AI provider is changed in settings and the flow runs again, proving the tool isn't locked to one provider.

### Draft success criteria [Guess: the product owner will confirm or replace these]
- A sample epic plus docs becomes a reviewed, routed set of Jira tickets in **under 15 minutes** of PM/BA time.
- Most generated items are kept with light editing (target: ≥70% accepted without major rewrite).
- At least a few clarifying questions or AI suggestions on the sample set are judged genuinely useful.
- Zero duplicate tickets after a partial failure and retry.

## 3. Non-goals (for this demo) [Decided]
- Handling requirement **changes** after tickets exist (re-sync or diff). Greenfield, first-time breakdown only. The draft-item ↔ Jira-key link is still stored, so this can be added later.
- A direct **OneDrive** connection. Files are uploaded.
- **Workload-aware or history-based** routing.
- A **Jira-native front end** (Forge app) and **ticketing systems other than Jira**. The code keeps an adapter boundary so these can be added.
- **Regenerating a single branch** of the tree with a comment. The demo regenerates the whole draft. Nice to have later.

## 4. Anti-goals: failure even if it "works" [Decided in intent; wording is the designer's]
- **Faked steps**: hard-coded AI output, a mocked "Jira", or scripted results in the demo path. Mocks are allowed in automated tests only.
- **Tickets created without human review.**
- **AI-invented scope presented as fact.** Every AI addition is visibly marked and must be accepted.
- **Team rules hard-coded in the app.** Breakdown conventions, ticket structure and routing come only from the uploaded files.
- **Demo-only shortcuts:** fake sign-in, secrets in source code, a single hard-wired AI provider.

---

## 5. Constraints

| Area | Constraint | Status |
|---|---|---|
| Platform | Standalone **web app** using the **Jira Cloud** REST API. Forge front end later. | [Builder's call, accepted] |
| Language / framework | **TypeScript**, **Next.js** (App Router): UI + API in one project | [Builder's call, not objected to] |
| Database | **PostgreSQL** | [Builder's call] |
| AI provider | **Not locked to one provider.** Speak the **OpenAI-compatible** API so any compatible endpoint works (OpenAI, Azure, Gemini compat, OpenRouter, company gateway, Claude via gateway). **Must later work with a local LLM** (Ollama / vLLM) with configuration changes only. | [Decided] |
| Jira auth | **Atlassian OAuth 2.0 (3LO), acting as the signed-in user.** The AI can never do more than that user can in Jira. | [Builder's call, accepted] |
| Confidentiality | Real requirement docs are confidential. **Never put document content in logs.** API keys and tokens encrypted at rest. Uploaded docs deleted on a retention policy. The UI shows which provider/model a project uses. | [Decided: docs are confidential; the measures are builder's calls] |
| Test data | No real company documents are available. Build **fictional sample docs**. | [Decided] |
| Dev machine | Windows 11. Must run locally there. | Fact |

### Prerequisites only the product owner can provide
Claude cannot create accounts or handle real credentials, so the product owner must:
1. Create a **free Jira Cloud site** (a test site, not a production one) with a scrum or kanban project and a few users/teammates to route to.
2. Create an **OAuth 2.0 (3LO) app** in the Atlassian developer console with callback `http://localhost:3000/api/auth/callback/atlassian` and give it the needed scopes. Put the client ID/secret into `.env.local` themselves.
3. Provide at least one **LLM endpoint + key** (put in the app's settings or `.env.local` by the owner).
4. Have **Postgres** available. Docker Compose will be provided; otherwise a local install.

Until these exist, everything is built and tested with automated tests (mocked Jira and LLM). The live end-to-end demo run needs them.

---

## 6. How it works

### 6.1 Main flow

```
[Sign in with Atlassian] → [Pick Jira project] → [New breakdown run]
   → Upload: epic text, reference docs, guideline files, routing file
   → (A) Ingest & section docs
   → (B) Structure check against Jira project metadata
   → (C) Routing-file check (people/teams resolved to Jira users)
   → (D) Clarifying questions  ⇄  PM/BA answers
   → (E) Draft breakdown tree (stories, tasks, AC, sources, AI suggestions)
   → (F) Route every ticket (assignee + reason + rule quote)
   → (G) Review & edit (tree + detail panel)
   → (H) Create in Jira (idempotent, partial-failure safe)
```

A **project** in the app = one linked Jira project + its saved guideline files, routing file and AI settings. A **run** = one epic going through the flow. Guideline and routing files are saved on the project, so they're reused across runs. Each run records the exact file versions it used (content hash).

### 6.2 Inputs [Decided]
- **Epic description:** free text.
- **Reference docs:** DOCX, PPTX, PDF, TXT, MD. Several per run.
- **Guideline files:** free-form **.md/.txt**. These hold the team's conventions: story format, AC style, sizing, standard tasks per story, **and ticket structure/hierarchy**. No rules are hard-coded.
- **Routing rule file:** a separate free-form **.md/.txt**. Rules can route to **a person** or to **a team/group**. Every team has a **default person** (lead or manager) who receives the ticket.

The app ships **starter templates** for a guideline file and a routing file, with suggested sections. They are optional. [Builder's call]

### 6.3 (A) Ingestion [Builder's call]
- Parse each file to plain text **split into numbered sections**, keeping headings. DOCX: by headings. PPTX: one section per slide. PDF: by page, then by detected headings if possible. MD: by headings. TXT: by blank-line blocks or headings.
- Each section gets a stable reference like `REQ.docx §3.2` or `design.pptx slide 4`. That's what tickets cite as their source.
- The PM/BA can see the extracted text ("what the AI read"), so they can catch bad parsing.
- Size guard: if the total input exceeds the model's configured context budget, warn and ask the PM/BA to remove documents. No automatic chunked summarization in the demo.

### 6.4 (B) Structure check [Decided: structure comes from guideline files; mechanics are builder's]
- Read the Jira project's issue types, hierarchy levels (Epic / standard / sub-task) and **required fields per issue type** through the Jira API.
- An AI step extracts the **intended structure** from the guidelines (e.g. "Epic → Story → Sub-task; test work as Sub-task with label `qa`"). The app validates it against the project's metadata.
- Mismatches are shown before drafting, e.g. "guideline asks for issue type 'Test' but this project has none".
- **If the guidelines don't specify a structure:** fall back to Epic → Story → Sub-task and say so.
- Required custom fields that the AI can't fill are surfaced in review as "missing required field" and block creation until filled.

### 6.5 (C) Routing file check [Decided: person or team + default person; mechanics are builder's]
- An AI step turns the free-form routing file into a structured roster: teams (name, default person, members), named people, and rules (condition text → target person or team).
- Every person name is resolved to a **Jira account ID** among the project's **assignable users** (deterministic matching by display name/email, with fuzzy match suggestions). The AI never invents account IDs.
- A "**Check routing file**" view lists teams, default persons, people, rules, and anything unresolved. Unresolved names are errors the PM/BA must fix (edit the file and re-upload, or pick the user manually), not guesses.

### 6.6 (D) Clarifying questions [Decided: stop and ask before drafting]
- The AI reads all inputs and returns questions, each tied to a source reference and categorized as **contradiction / ambiguity / missing information**.
- Ranked by importance, **capped at ~10**. If there are none, the run goes straight to drafting.
- Each question can be **answered**, marked **out of scope**, or set to **"use your judgment"**. Tickets that depend on a judgment call are tagged **Assumption** in review.
- Answers are saved with the run and added to the epic's Jira description under a **"Clarifications"** heading. [Builder's call]

### 6.7 (E) Draft breakdown [Decided: output shape; generation strategy is builder's]
Each draft item has: type (mapped to a Jira issue type), title, description (story format per guidelines), acceptance criteria, optional estimate if the guidelines ask for one, parent, **source references**, `origin` (`from_docs` | `ai_suggestion`), `assumption` flag, and the guideline files that shaped it.
- **AI suggestions** are extra stories, tasks or edge cases not grounded in the docs. They're marked, and must be **accepted or rejected** before creation. Rejected ones are excluded.
- The epic itself: if the PM/BA picks an **existing Jira epic**, the children are created under it; otherwise a new epic is created from the epic description. [Builder's call]
- Generation strategy is left to the builder: one call, or epic→stories then stories→tasks. The output must be **schema-validated** (Zod) with automatic retries on invalid output.

### 6.8 (F) Routing [Decided: behavior]
- For each ticket, the AI picks the best rule and returns target + **reason + quoted rule text** (with line reference into the routing file).
- The target is resolved deterministically: person → their account ID; team → the team's **default person**.
- Where the Jira project has a **Team field** or **components** matching the team, set them too. [Builder's call]
- No rule fits → **"Needs decision"**, left unassigned. **Never guess.**

### 6.9 (G) Review screen [Decided: layout A, tags after text]
Visual reference: `.superpowers/mockups/review-layout-v2.html`.
- **Left:** the tree (epic → stories → tasks). The **title comes first, tags after it**: type tag, and `AI suggestion` / `Assumption` tags where they apply. AI-suggestion rows have **Accept / Reject** inline.
- **Right:** detail of the selected item. Editable title, description, acceptance criteria, type, parent; source references; routing (assignee, reason, rule quote, **Change**); "shaped by" guideline files.
- **Top bar:** Regenerate (whole draft), filter to AI suggestions, counter of blocking issues, **Create N tickets in Jira**.
- Tree editing: add, delete, rename, move to another parent.
- **Create is blocked** while any item is an unresolved AI suggestion, needs a routing decision, or is missing a required field. A list jumps to each blocker.
- Draft edits are saved automatically to the database. Closing the browser doesn't lose work.
- **Regenerate** [Builder's call] is available only **before any ticket has been created** for the run. It replaces the whole draft after a confirmation that warns that edits, Accept/Reject decisions and routing changes will be lost. Clarifying-question answers are kept and reused. Once any item has a Jira key, Regenerate is disabled; only Retry failed remains.

### 6.10 (H) Creation in Jira [Builder's call: mechanics]
- Create top-down: epic → stories → children. Use Jira bulk create where possible; set `parent` per hierarchy, assignee, Team/components, labels.
- **Idempotent:** each draft item stores its Jira key the moment it's created. A retry only creates items without a key, so a partial failure never produces duplicates.
- **Crash-safe marker** [Builder's call]: every created issue gets the labels `ai-backlog` and `ai-run-<shortRunId>`, and its description ends with a small hidden-in-plain-sight footer `ai-backlog-item: <draftItemId>`. Before any retry, the app searches Jira (JQL on the run label) and re-links any issue that was created but whose key wasn't saved. "Zero duplicates" covers tickets this app created; existing children of a chosen epic are left alone.
- **AI-suggested tickets stay marked in Jira** [Builder's call, follows the anti-goal]: accepted AI suggestions get the label `ai-suggested`, and their description starts with a one-line note saying the item was proposed by AI and accepted by <PM/BA name>.
- **Existing epic** [Builder's call]: when the PM/BA picks an existing epic, the review screen shows exactly what will be written to it before Create: the "Clarifications" block to be **appended** (never overwriting existing text) and the children to be added. Existing children are not modified. If the epic's description changed since the run started, the app re-reads it just before writing and still only appends.
- Failures show the reason per item, with **Retry failed**.
- After success, each tree item shows its **Jira key as a link**.

### 6.11 AI provider layer [Decided: multi-provider, local later; mechanics are builder's]
- Use the **Vercel AI SDK** with its OpenAI-compatible provider. Configuration = base URL, API key, model name, plus optional settings (temperature, JSON mode support).
- **Several provider profiles** can be stored; a project picks one. **Per-step model override** (e.g. a cheaper model for routing) is supported in config, but the demo UI only needs one model per project.
- Structured output: ask for JSON matching a Zod schema; validate; retry up to N times with the validation error fed back. Don't depend on provider-specific "strict JSON schema" features, but use them when the profile says they're supported.
- **Prompts live in versioned files** in the repo, not scattered through code.
- API keys are entered in settings and stored **encrypted** (key from env). `.env.local` is supported as a fallback.

### 6.12 Ticketing adapter [Builder's call]
- One interface (`TicketingAdapter`): get project metadata (issue types, hierarchy, required fields), list assignable users, create issues (bulk), link issues, update an issue description. Jira Cloud is the only implementation.
- Core logic (pipeline, draft model, routing) never imports Jira-specific code.

### 6.13 Security and data handling [Builder's call within the confidentiality constraint]
- Sign-in through Atlassian OAuth; the session holds the user's tokens (refresh tokens encrypted at rest).
- **Access model [Decided: shared per Jira project]:** an app project, its files, runs, drafts and uploaded documents are visible to **any signed-in user who can browse the linked Jira project**, checked with that user's own Jira token (result cached for a few minutes). The user who created the app project is its **owner**. Only the owner can change the project's AI provider profile and keys, or delete the project. Everyone with access can create and review runs. API keys are never shown back in the UI, only their last 4 characters. Tickets are always created with the token of the user who clicks Create.
- **No document content, prompts or model outputs in logs**. Log only IDs, sizes, timings and errors.
- Retention: uploaded files and extracted text are **deleted N days after the run completes** (default 7, configurable). Drafts keep only what became tickets plus metadata.
- Retention trigger [Builder's call]: a purge runs **at app startup and then hourly** in-process. A run counts as complete when all its items are created, or when it has had **no activity for N days** (abandoned). The purge is a plain function so it can later move to a real scheduler.
- The project page shows the active provider and model clearly.

---

## 7. Data model (outline) [Builder's call]
- `User` (Atlassian account ID, name, encrypted tokens)
- `Project` (Jira site + project key, provider profile, retention days)
- `ProjectFile` (kind: guideline | routing, name, content, hash, version, active)
- `ProviderProfile` (name, base URL, encrypted key, model, capabilities)
- `Run` (project, epic text, existing epic key?, status, file versions used, timestamps)
- `RunDocument` (filename, type, extracted sections JSON, deleted_at)
- `ClarifyingQuestion` (run, category, text, source refs, rank, resolution: answered | out_of_scope | judgment, answer)
- `DraftItem` (run, parent, type, title, description, AC, estimate, sources, origin, assumption, accepted?, assignee account ID, routing reason, rule quote, needs decision, jira key, create error)
- `Roster` snapshot per run (teams, default persons, people, rules, unresolved names)

## 8. Sample data and evaluation [Decided: fictional docs; details are builder's]
- A fictional product (e.g. an online shop "Checkout Revamp" epic) with: a requirements DOCX, a design PPTX, a PDF spec, a guideline MD, a routing MD. **Deliberate flaws** are planted so the clarifying-questions step has something to find (one contradiction, one ambiguity, one gap).
- The same set serves as an **evaluation harness**: a script runs the pipeline against a chosen provider profile and reports schema validity, item counts, whether planted flaws were caught, and routing coverage. That's how models are compared.

## 9. Testing [Builder's call]
- Unit tests for parsers, schema validation/retry, roster resolution, routing resolution, idempotent creation.
- Pipeline tests with a **fake LLM** (recorded fixtures) and a **fake ticketing adapter**. Tests only; never in the demo path.
- A manual **live smoke test** against the real Jira test site once the prerequisites exist.

## 10. Left to the builder
- Exact UI component library and styling (keep it clean; follow the mockup structure).
- Prompt wording, the generation strategy (single vs staged), retry counts.
- Parsing libraries per format.
- Migration and ORM tooling.
- How the run's steps are presented (wizard steps vs one page with stages), as long as the order in §6.1 holds and the review screen matches §6.9.

## 11. Open items for the product owner
- Confirm or replace the **draft success criteria** (§2).
- Provide the **prerequisites** in §5 before the live demo run.
