# Reading Effective Policy

At Intent birth, Core creates an immutable Effective Policy snapshot in this
fixed priority order:

1. `org`
2. `team`
3. `project`
4. structured Intent risk facts

The first three sources are copied from
`aidlc/spaces/<active-space>/memory/{org,team,project}.md`. The snapshot records
each source path, exact content, and SHA-256 digest.

There is no work type, Scope, phase profile, or Stage selector. A later change
to Memory requires a new Effective Policy revision; it never silently changes
an existing Intent's policy.
