package main

import (
	"bytes"
	"testing"
)

func TestRunDelegatesToCLI(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	if got, want := run([]string{"--version"}, &stdout, &stderr), 0; got != want {
		t.Fatalf("run() exit code = %d, want %d", got, want)
	}
	if got, want := stdout.String(), "aidlc 1.0.0\n"; got != want {
		t.Fatalf("run() stdout = %q, want %q", got, want)
	}
	if stderr.Len() != 0 {
		t.Fatalf("run() stderr = %q, want empty", stderr.String())
	}
}
