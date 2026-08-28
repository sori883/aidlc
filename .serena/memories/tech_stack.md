# Tech stack
- Go module `github.com/sori883/aidlc`; language/toolchain contract: Go 1.26.4.
- Production runtime, installer, distribution, and quality gates are Go implementations.
- Prefer Go standard library; adding an external module requires user approval.
- Primary harness: Codex; hook contract lives in `harness/codex/`.