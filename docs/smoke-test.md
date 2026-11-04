# Live smoke test

This checklist is for a person to run against a real Jira Cloud **test** site. It follows the demo flow in the design spec, §2, steps 1–9, and adds the failure and retention checks. Automated tests use a fake LLM and a fake Jira. Only this checklist covers the real service.

Use the sample set in `samples/checkout-revamp`. Upload the files as listed below.

## Before you start

- [ ] A Jira Cloud **test** site exists, with a scrum or kanban project and at least three users you can route tickets to. Your team's own site is not used here.
- [ ] The OAuth 2.0 (3LO) app exists, with the callback `http://localhost:3000/api/auth/callback/atlassian` and the scopes `read:jira-work write:jira-work read:jira-user read:me offline_access`.
- [ ] `.env.local` holds `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `SESSION_SECRET` and `ENCRYPTION_KEY`, generated as described in the README.
- [ ] An LLM endpoint and key are ready. Decide whether the sample documents may go to this provider. Use a local model for anything confidential.
- [ ] `npm test` and `npm run typecheck` pass on this machine.
- [ ] `npm run dev` runs, and http://localhost:3000 loads.

## 1. Sign in and pick a project

- [ ] Sign in with Atlassian. The consent screen lists the scopes above, and you approve them yourself.
- [ ] Create an app project linked to the Jira test project.
- [ ] The project page shows the AI provider and model in use.

## 2. Upload the inputs

- [ ] Epic text: paste the contents of `samples/checkout-revamp/epic.md`.
- [ ] Reference documents: upload `requirements.docx`, `design.pptx` and `api-spec.pdf`.
- [ ] Guideline file: upload `guidelines.md`.
- [ ] Routing file: upload `routing.md`.
- [ ] The extracted text of each document is readable in the app. Sections carry references such as `requirements.docx §2.1`.

## 3. Structure check (spec §6.4)

- [ ] The check reports the structure from the guidelines: Epic → Story → Sub-task.
- [ ] Each type name is checked against the Jira project. No mismatch is reported for the test project.
- [ ] Any mismatch shows before drafting. To confirm this, rename the story type in `guidelines.md` to a type that does not exist, re-check, and see the error. Then restore the file.

## 4. Routing file check (spec §6.5)

- [ ] Teams Frontend, Backend, QA and Payments appear with their default persons.
- [ ] People appear and resolve to Jira users. Nguyễn Văn An resolves despite the diacritics.
- [ ] Any unresolved name is listed as an error, not guessed.
- [ ] The rules appear with their line numbers and quotes.

## 5. Clarifying questions (spec §6.6)

- [ ] Ten or fewer questions appear, ranked, each with a category and a source reference.
- [ ] A **contradiction** cites `requirements.docx §2.1` and `§3.2`.
- [ ] An **ambiguity** cites `requirements.docx §1` and mentions "fast".
- [ ] A **gap** is about payment timeout or failure handling.
- [ ] Answer one question, mark one as out of scope, and set one to "use your judgment".
- [ ] Answering works without a page reload.

## 6. Draft breakdown (spec §6.7)

- [ ] The draft has one epic, stories and sub-tasks. Each has a description, acceptance criteria and a source reference.
- [ ] Each story has a sub-task titled "QA: test <story>", as the guidelines ask.
- [ ] AI-proposed items, such as "Payment timeout handling", are marked as AI suggestions and must be accepted or rejected.
- [ ] Items that rest on a judgment call are tagged **Assumption**.

## 7. Routing (spec §6.8)

- [ ] Every story and sub-task has an assignee and a reason. The reason quotes the routing rule it used.
- [ ] Payment work goes to the Payments team's default person, and QA sub-tasks go to QA.
- [ ] Items the model could not route are flagged "needs decision", and Create is blocked until each has an assignee.
- [ ] Override one assignee by hand. The override is kept.

## 8. Review and create (spec §6.9, §6.10)

- [ ] Edit one title and one acceptance criterion. Edits are kept.
- [ ] Accept one AI suggestion and reject another.
- [ ] Click **Create**. A progress indication appears, and each tree item gets its Jira key as a link.

## 9. Check in Jira (spec §2 step 8)

- [ ] The epic is an Epic. Each story is a Story under the epic. Each sub-task is under its story.
- [ ] Each issue has the assignee the app showed.
- [ ] Labels: `ai-backlog`, `checkout` and `ai-run-<first 8 characters of the run ID>` on every issue. The accepted AI suggestions also carry `ai-suggested`.
- [ ] Components match the teams, for example Payments on the payment work.
- [ ] The description of an accepted AI suggestion starts with "Proposed by AI and accepted by <your name>."
- [ ] Every description ends with the footer `ai-backlog-item: <id>`.
- [ ] The epic's description keeps its original text and has a **Clarifications** section appended. The text was not overwritten.

## 10. Forced retry: no duplicates (spec §6.10, Review Focus 4)

Use a second run, so you can see both creation attempts.

- [ ] Before Create, remove one routed person from the Jira test project. Jira will refuse to assign that person, so creation fails for those items.
- [ ] Click **Create**. The items for the other people are created. The failed items show Jira's reason.
- [ ] Restore that person to the project.
- [ ] Click **Retry**. Only the failed items are created.
- [ ] In Jira, search `labels = "ai-run-<first 8 characters of the run ID>"`. Each draft item appears exactly once.
- [ ] Click **Create** a third time. Nothing new is created, and the epic's Clarifications appear only once.

## 11. Switch provider and run again (spec §2 step 9)

- [ ] In settings, change the project's provider to a different endpoint or model.
- [ ] The project page shows the new provider and model.
- [ ] Start a new run on the same epic. Questions, draft and routing all complete.
- [ ] `npm run eval` runs against the new provider, and its table and JSON file show the same steps.

## 12. Retention (spec §6.13)

The app does not accept a retention of 0 days. The project setting and `RETENTION_DAYS` must be at least 1, so this check uses 1 day and older timestamps.

- [ ] Set the project's retention to 1 day in the Retention section.
- [ ] Finish a run, so that it has a completed time.
- [ ] Make the run older than the retention period. Use Postgres (`DATABASE_URL` set to a real server), and run:

  ```sql
  UPDATE runs
     SET completed_at = now() - interval '2 days',
         last_activity_at = now() - interval '2 days'
   WHERE id = '<run id>';
  ```

  With the embedded PGlite database there is no SQL client, so this check cannot be done as written. Record it as not run.
- [ ] Restart the app. The purge runs at startup, and then every hour.
- [ ] Open the run's documents. The text shows **Deleted by retention policy**.
- [ ] Jira is unchanged by the purge. The tickets that were created remain.

## 13. Confidentiality in the logs

- [ ] While the flow runs, the terminal shows only JSON log lines with the allowed keys: IDs, counts, durations, status, step, error code and model.
- [ ] No line contains document text, a prompt, a model reply or a question. Search the terminal for a distinctive sentence from `requirements.docx`. It must not appear.

## Sign-off

- [ ] Every step above passed, or each failure is written down with its cause.
- [ ] Date: __________  Tester: __________  Jira site: __________  Provider and model: __________
