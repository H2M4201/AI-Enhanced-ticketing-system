# Backlog guidelines: Checkout Revamp

These rules apply to every ticket created for this epic.

## Story format

Write each story as: "As a <shopper or role>, I want <capability>, so that <benefit>."
Keep titles under 80 characters. Start the title with the area, for example "Checkout: save a card".

## Acceptance criteria style

Write acceptance criteria as a checklist. Each item is one observable behaviour that can be checked by a tester.

- [ ] The criterion uses the words "shopper", "guest" or "account holder".
- [ ] The criterion names the page or endpoint it applies to.

## Sizing

Estimate stories in story points using 1, 2, 3, 5 or 8. Stories larger than 8 must be split.

## Ticket structure

Use the structure Epic → Story → Sub-task.

- The epic is an Epic issue.
- Each user-facing piece of work is a Story under the epic.
- Engineering or test work under a story is a Sub-task under that story.
- Every story gets a Sub-task titled "QA: test <story>" that covers its acceptance criteria.

## Standard tasks per story

- One Sub-task "QA: test <story>" for every story.
- Database or migration work is a Sub-task under the story that needs it.

## Labels

Add the label "checkout" to every ticket created from this epic.
