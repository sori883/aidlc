# Suggested commands
- Format tracked Go: `git ls-files -z -- '*.go' ':(exclude)work/**' | xargs -0 gofmt -w`
- Vet: `go vet ./...`
- Tests: `go test -count=1 ./...`
- Race tests: `go test -race -count=1 ./...`
- Native build: `go build -trimpath -o build/go/aidlc ./cmd/aidlc`
- Release package: `go run ./cmd/aidlc-dev package-release --out build/github-release`
- Keep `GOCACHE` outside the repository for development and CI commands.