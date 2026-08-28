# Task completion
Run with a repository-external Go cache:
1. `gofmt` on changed Go files.
2. `go vet ./...`
3. `go test -count=1 ./...`
4. `go test -race -count=1 ./...` when the change touches concurrency, locking, hooks, state, distribution, or release behavior.
5. `go build -trimpath -o build/go/aidlc ./cmd/aidlc`
All build output stays under `build/`.