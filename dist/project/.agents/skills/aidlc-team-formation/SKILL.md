---
name: aidlc-team-formation
description: Run the AI-DLC team-formation Stage in isolation without advancing the active Intent.
---

<!-- generated-by: aidlc-runner-gen -->

# AI-DLC Stage Runner: team-formation

Run the `team-formation` Stage once. This is explicit packaging over
`$aidlc`; first read `../aidlc/SKILL.md` and follow its **Single Stage**
branch. Do not update the active Intent's Current Stage.

1. Request the isolated directive:

   `./.aidlc/bin/aidlc orchestrate next --project-dir . --stage team-formation --single`

2. Preserve every `load-steering` part and repeat the same command with
   `--continue-token <token>` until `run-stage` is returned.
3. Execute the returned topology, Stage file, inputs, outputs, Rules, Memory,
   Reviewer, and Learnings instructions exactly as `$aidlc` specifies. The
   isolated directive has `single: true` and `gate: false`.
4. Record the isolated lifecycle:

   `./.aidlc/bin/aidlc orchestrate report --project-dir . --stage team-formation --result completed --single`

Stop after the `done` directive. Never report against the main workflow.
