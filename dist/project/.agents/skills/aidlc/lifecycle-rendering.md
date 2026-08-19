# Codex lifecycle rendering annex

This annex maps the Harness-neutral Stage Protocol to Codex UI operations. It
does not own AI-DLC State or Audit transitions.

Before a Stage begins:

1. Mark the previous Stage task `completed` when it is still `in_progress`.
2. Mark the current Stage task `in_progress` with an active form of
   `Running [Stage Name] [slug]`.
3. If task IDs are no longer in context, list tasks and match the Stage subject.
4. For a skipped Stage, complete the task with `Skipped: [reason]` appended to
   its description.

Codex's `PostToolUse` event is the Adapter input for post-write Sensor firing.
The Adapter converts Codex `apply_patch` payloads into the Core Write/Edit
payload. It must not edit `aidlc-state.md` or Audit files directly.

If the Codex task UI or hook is unavailable, continue through the Core engine.
The logical Directive, State transition, Audit Event, and approval semantics do
not change.
