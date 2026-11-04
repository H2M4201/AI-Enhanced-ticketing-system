# Backlog guidelines

Upload this file to a project. Edit the sections to match how your team works. The AI follows these rules over its defaults.

## Story format

Write each story as: "As a <role>, I want <capability>, so that <benefit>."
Keep the title under 80 characters. Put the detail in the description.

## Acceptance criteria style

- Write each criterion as a testable statement, in Given / When / Then form.
- Use one criterion per behaviour. Aim for 3 to 6 per story.
- Name the user-visible result, not the implementation.

## Sizing

- A story fits in one sprint for one person.
- Split any story that needs more than 8 tasks.
- Mark anything that needs a new external dependency as a question, not a story.

## Standard tasks per story

Every story gets these tasks unless the story says otherwise:

1. Implement the change.
2. Write automated tests for the acceptance criteria.
3. Update the documentation the change affects.

## Ticket structure

- Epic: one per initiative, with a short goal and the success measure.
- Story: one per user-visible capability, under the epic.
- Sub-task: one per standard task, under the story.
