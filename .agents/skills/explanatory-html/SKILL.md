---
name: explanatory-html
description: Create or repair self-contained explanatory HTML from canonical project sources. Use when a first-time reader needs a concise, context-free explanation with responsive layout or visual QA; do not use for product UI or ordinary Markdown documentation.
---

# Explanatory HTML

Turn an existing specification or fact set into HTML that a first-time reader can understand without changing its meaning.

## Reusable template

- For a new page, start from [assets/explanation-template.html](assets/explanation-template.html) when it fits the requested output.
- Keep the template's accessibility and responsive rules, then replace its generic visible content with facts from the current source of truth.
- Do not force the template onto an existing page when a focused repair preserves the established design more safely.

## Authority and scope

- Identify the source of truth before writing. Prefer current canonical files and explicitly supplied facts over prior conversation wording or an older explanatory draft.
- Preserve facts, decisions, IDs, order, and authority boundaries. Do not fill gaps with plausible details.
- If the source, audience, or output path is materially ambiguous, ask before writing.
- Edit only the requested documentation. Do not change Runtime, Contract, or canonical JSON artifacts, implementation code, or unrelated user changes unless the user explicitly requests it.
- If the user asks for a fresh or zero-clear explanation, derive the explanation again from the source of truth instead of copying the old page's framing.

## Explain for a beginner

- Use the requested language and define each unfamiliar term when it first appears.
- Prefer one idea per sentence. Keep paragraphs short.
- Lead with what the reader will understand or be able to decide.
- Separate input, action, output, and human decision points when they exist.
- Use a small example to ground an abstract rule, but label it as an example.
- Add a diagram only when sequence, hierarchy, dependency, or a multi-part handoff becomes materially clearer. Provide the same meaning in nearby text.
- Do not add decorative diagrams that repeat a single simple sentence.

## HTML contract

- Produce a self-contained single-file HTML document unless the user requests another structure.
- Include `lang`, UTF-8 charset, viewport metadata, a descriptive title, semantic headings, and a visible page title.
- Keep CSS inside the document. Do not use a CDN, remote font, remote script, analytics, or external runtime unless explicitly requested.
- Keep the page usable without JavaScript. Add JavaScript only when interaction is part of the request.
- Escape source-controlled or user-provided text before inserting it into HTML. Never expose secrets or credentials.
- Use semantic lists, tables, `figure`/`figcaption`, and accessible link text. Do not rely on color alone to convey meaning.
- Maintain readable contrast, focus visibility, and a comfortable line length.
- Include responsive rules for narrow screens. Use `min-width: 0`, `max-width: 100%`, and `overflow-wrap: anywhere` where long text may appear.
- Wrap genuinely wide tables or code in a local scrolling container instead of making the whole page scroll sideways.
- Keep a process diagram's DOM in reading order. Do not place alternating nodes and arrows into a generic multi-column grid that can reorder the baton on narrow screens.
- Add print rules when they materially improve a document intended for review or approval.

## Verify the result

1. Compare names, IDs, order, inputs, outputs, and authority statements with the source of truth.
2. Check HTML structure, duplicate IDs, local anchors, and missing referenced files.
3. When browser tooling is available, inspect at a mobile width around 390px and at a desktop width.
4. Confirm page-level `scrollWidth <= clientWidth` at both widths. A deliberately scrollable table or code wrapper may overflow internally.
5. Check for clipped text, overlap, unexpected whitespace, broken cards, unreadable code, and missing focus states.
6. Follow every diagram, arrow, and handoff baton in visual order. Confirm that the same order is clear in the document text.
7. If the user requested only a display repair, preserve wording and facts and limit the change to layout or styling.

If browser verification is unavailable, do not claim that visual QA passed. Perform the strongest structural check available and report exactly what was and was not verified.

## Handoff

Report the absolute HTML path, the canonical sources used, the desktop and mobile checks performed, and any unresolved limitation. Keep the report concise.
