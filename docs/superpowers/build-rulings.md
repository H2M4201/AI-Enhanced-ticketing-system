# Build rulings: Epic-to-Backlog Copilot

Decisions the builder made during implementation where the plan or spec was silent or in conflict. Format: what was decided, why, and the cost if wrong.

- Ruling: work on a feature branch in place instead of a worktree — the repo is new with only docs on master; user asked to build — cost if wrong: none, branch can be moved.
- Ruling: scaffold into a temp subfolder and move files up; keep existing .gitignore lines — cost: none
- Ruling: T2 adds `assignableUsers jsonb` (AssignableUser[]) to runs; T15 runChecks stores it — cost if wrong: one extra column
- Ruling: T4 writes JSON to the T6 shape quoted in the T4 dispatch; T6 types it — cost: small JSON fix
- Ruling: T21 edits ExtractedTextDialog/API for purged docs — cost: none
- Ruling: .env.example non-secret defaults stand — the constraint's intent is no secrets in source; defaults mirror code — cost if wrong: trivial edit
- Ruling: next.config.ts template options cacheComponents/partialPrefetching are removed in Task 2 — they change dynamic/cookie semantics that auth and route handlers rely on — cost if wrong: re-add two lines
- Ruling: commit trailer stays 'Claude Opus 5.5' for all tasks (session attribution rule) even when a Haiku/Sonnet subagent wrote the code — cost if wrong: cosmetic
- Ruling: getDb dev hot-reload double-open — carry into Task 16 dispatch: store the db promise on globalThis outside production — cost if wrong: PGlite lock error in dev only
- Ruling: sample-length "Important" is overruled — my 40–120 guideline was meant as a cap to keep fixtures short, not a minimum; short samples serve the tests — cost if wrong: thinner demo docs, easy to extend
- Ruling: corrupt-file errors (reviewer Minor) promoted into the fix loop — same class as Review Focus #1 (unreadable upload must give a clear error naming the file) — cost if wrong: one small extra fix
- Ruling: adf.ts \r\n normalisation and empty-heading (Jira rejects empty text nodes) are fixed in Task 7, since that's where real Jira consumes ADF — cost if wrong: small
- Ruling: chunk-level failure after earlier chunks succeeded returns per-item failures instead of throwing (only a first-chunk failure throws) — keeps created keys so no duplicates — cost if wrong: auth errors mid-batch show as item errors
- Ruling: network (non-JiraError) failures may still propagate from createIssues — Task 14's label-based recovery reconciles any issues created before the throw — cost if wrong: one retry needed
- Ruling: Task 11 Important #2 (inline markdown chars) needs no fix — textToAdf only interprets line-leading `## `/`- `/`- [ ] `, never inline `*`/`_`/backticks — cost if wrong: cosmetic formatting
- Ruling: Task 12 collapses whitespace in titles and caps them at 255 chars (Jira summary limit, single line) — cost if wrong: trimmed titles
- Ruling: guideline-mandated tasks (no doc refs, but valid shapedBy, under a from_docs story) stay from_docs — they're team conventions, not invented scope; otherwise every 'QA: test …' sub-task would need Accept — cost if wrong: fewer items flagged for review. Goes into Task 12 fix round.
- Ruling: accept that any task citing a valid guideline under a from_docs story is from_docs, even if the guideline doesn't literally mandate it — scope is gated at story level, and tasks under a grounded story are implementation detail the PM/BA still reviews — cost if wrong: some AI-invented tasks not flagged
- Ruling: lock via runs.creatingSince with a 10-min stale timeout plus runs.draftVersion optimistic check — avoids SELECT FOR UPDATE, which PGlite handles poorly — cost if wrong: a crashed create blocks Retry for 10 min.
- Ruling: zero questions keeps status 'questions' with an empty list (the earlier dispatch ruling stands over the brief's wording) — Task 19's UI must skip straight to Generate draft when the list is empty — cost if wrong: one extra click.
- Ruling: stale-lock overlap with a slow but live create (>10 min) is accepted for the demo — cost if wrong: possible duplicates on a 10-min create, which label recovery partly reconciles.
- Ruling: extra error mappings (RunStateError 409 run_state, NotFoundError 404, zod 400 invalid_request); PATCH draft carries expectedVersion; GET /projects lists owned plus accessible projects (no sites stored); POST /projects verifies browse permission; 413/415 upload limits; 500 messages are fixed — the brief's mapping list was incomplete for errors added in T15/T16 — cost if wrong: a UI code change.
- Ruling: global vitest testTimeout of 20s is accepted — PGlite setup is slow under parallel files — cost if wrong: slow tests are noticed later.
- Ruling: "Start a new breakdown" navigates to /projects/[id]/runs/new, which Task 19 builds; npm run build must pass without .env.local, using force-dynamic rather than weakening env validation — cost if wrong: a route rename in T19.
- Ruling: members may upload project files and only removal is owner-only — the spec says shared per Jira project and only the provider and keys are owner-only — cost if wrong: one UI flag.
- Ruling: the new-run URL is /runs/new?project= as in the brief, and T19 updates T18's link — the brief is binding over T18's placeholder — cost if wrong: none.
- Ruling: added epicText and the document GET route are accepted as needed for the brief — cost if wrong: none.
- Ruling: the review screen serializes PATCHes with a promise chain; a run_state conflict shows Reload; in 'creating' only update/route on unkeyed items; Retry is held 10s after a failure (Jira search is eventually consistent) — cost if wrong: a 10s wait.
- Ruling: Retry K = active uncreated items (server retry creates every unkeyed item) — cost if wrong: a label mismatch only.
- Ruling: pipeline ops on a run with purged docs throw RunStateError rather than running on empty text; the loop guard lives on globalThis — cost if wrong: an abandoned run can't resume (the user starts a new one).
- Ruling: eval runs core pipeline functions with no DB and a fake adapter; output has counts only; CLI runs only when executed directly — cost if wrong: the eval misses service-level wiring (covered by the run-service tests).
- Ruling: the smoke test uses retention of 1 day plus SQL backdating rather than 0 days — the minimum of 1 is deliberate — cost if wrong: one doc edit. Note: the implementer's attempt to read .env.local was denied and not retried, which is correct.
- Ruling: guideline-requested labels are not applied — listed as a known deviation — cost if wrong: a later feature.
- Ruling: clearing a resolution on the server, the draft-item purge and the focus trap stay parked — demo scope — cost if wrong: minor privacy and UX gaps, documented.
- Ruling: member file upload and owner-only removal kept and documented — matches the earlier T18 ruling — cost if wrong: one guard change.
- Ruling: the residual is load-bearing (Jira duplicates are hard to undo) → one residual round: a label lookup before regenerate/delete/reject when lastCreateFinishedAt is set, plus regenerate refused on purged docs, plus lint cleanup — cost if wrong: one extra Jira call on rare paths.
