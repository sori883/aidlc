# Human questions and approval gates

Use the structured `request_user_input` tool when it is available. Otherwise,
ask the same question directly in chat. Never manufacture a response.

For Learnings candidates, show the stable candidate ID, summary, destination
choice (`project`, `team`, or skip), and any org-level conflict. Keep the
candidate's original meaning when proposing a shorter Rule line.

Always ask: **Anything else to add from this Stage?** An explicit “nothing” is
a valid answer and must still produce `anything_to_add_answered: true` in the
selections JSON.

For the final Stage gate, summarize the produced files, Reviewer verdict, Sensor
results, persisted learnings, open questions, and deviations. Ask the user to
approve or request revision. Call `report --result approved` only after an
explicit approval in the current turn.
