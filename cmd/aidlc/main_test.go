package main

import (
	"bytes"
	"testing"
)

func TestRunFailsClosedDuringStage1(t *testing.T) {
	var stderr bytes.Buffer

	if got, want := run(&stderr), 1; got != want {
		t.Fatalf("run() exit code = %d, want %d", got, want)
	}
	if got, want := stderr.String(), stage1UnavailableMessage+"\n"; got != want {
		t.Fatalf("run() stderr = %q, want %q", got, want)
	}
}
