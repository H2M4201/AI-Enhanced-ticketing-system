# Prompt templates

Each prompt is a Markdown file named after its `PromptName` (`structure`, `roster`, `clarify`, `draft`, `route`), e.g. `structure.md`.

- Write placeholders as `{{var}}`. Every placeholder must be supplied by the caller, or `renderPrompt` throws and names the missing variable.
- Values are inserted verbatim. Keep instructions in the template and pass document text only as variables.
- Ask for JSON only when the output is parsed by `generateValidated`, and say which schema it must match.
- Load with `renderPrompt(name, vars)` from `src/core/llm/prompts.ts`. Tests can pass a directory as the third argument.
