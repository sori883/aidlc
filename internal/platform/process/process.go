// Package process runs explicit argv commands with bounded execution time.
package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// Request contains the complete external-process contract.
type Request struct {
	Executable string
	Args       []string
	Dir        string
	Env        []string
	Timeout    time.Duration
	ExitCodes  []int
}

// Result contains captured process output.
type Result struct {
	ExitCode int
	Stdout   []byte
	Stderr   []byte
}

// Run executes a command directly, never through a shell.
func Run(ctx context.Context, request Request) (Result, error) {
	if request.Executable == "" {
		return Result{}, fmt.Errorf("process executable is required")
	}
	timeout := request.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(commandContext, request.Executable, request.Args...)
	command.Dir = request.Dir
	command.Env = request.Env
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	result := Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if err != nil {
		if errors.Is(commandContext.Err(), context.DeadlineExceeded) {
			return result, fmt.Errorf("process timed out after %s", timeout)
		}
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			result.ExitCode = exitError.ExitCode()
		} else {
			result.ExitCode = -1
			return result, fmt.Errorf("start process: %w", err)
		}
	}
	allowed := request.ExitCodes
	if len(allowed) == 0 {
		allowed = []int{0}
	}
	for _, code := range allowed {
		if result.ExitCode == code {
			return result, nil
		}
	}
	return result, fmt.Errorf("process exited with code %d", result.ExitCode)
}
