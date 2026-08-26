package process

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunUsesArgvWithoutShell(t *testing.T) {
	t.Parallel()
	result, err := Run(context.Background(), Request{
		Executable: os.Args[0],
		Args:       []string{"-test.run=TestProcessHelper", "--", "$HOME;exit 9"},
		Env:        append(os.Environ(), "GO_WANT_PROCESS_HELPER=1"),
		Timeout:    5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(result.Stdout), "$HOME;exit 9"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestProcessHelper(t *testing.T) {
	if os.Getenv("GO_WANT_PROCESS_HELPER") != "1" {
		return
	}
	for index, value := range os.Args {
		if value == "--" && index+1 < len(os.Args) {
			_, _ = os.Stdout.WriteString(os.Args[index+1])
			os.Exit(0)
		}
	}
	os.Exit(2)
}

func TestRunTimesOut(t *testing.T) {
	t.Parallel()
	_, err := Run(context.Background(), Request{
		Executable: os.Args[0],
		Args:       []string{"-test.run=TestProcessTimeoutHelper"},
		Env:        append(os.Environ(), "GO_WANT_PROCESS_TIMEOUT_HELPER=1"),
		Timeout:    10 * time.Millisecond,
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("Run() error = %v, want timeout", err)
	}
}

func TestProcessTimeoutHelper(t *testing.T) {
	if os.Getenv("GO_WANT_PROCESS_TIMEOUT_HELPER") != "1" {
		return
	}
	time.Sleep(time.Minute)
}
