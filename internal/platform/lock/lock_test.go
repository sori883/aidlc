package lock

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestWithIsReentrantAndReleased(t *testing.T) {
	projectDir := t.TempDir()
	if err := With(context.Background(), projectDir, Options{}, func(ctx context.Context) error {
		if !Exists(projectDir) {
			t.Fatal("lock is not held")
		}
		return With(ctx, projectDir, Options{}, func(context.Context) error {
			if !Exists(projectDir) {
				t.Fatal("nested lock is not held")
			}
			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}
	if Exists(projectDir) {
		t.Fatal("lock was not released")
	}
}

func TestAcquireRejectsCompetingOwner(t *testing.T) {
	projectDir := t.TempDir()
	handle, err := Acquire(context.Background(), projectDir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer Release(handle)
	if _, err := Acquire(context.Background(), projectDir, Options{NoRetry: true}); err == nil {
		t.Fatal("competing Acquire() succeeded")
	}
}

func TestWithReleasesAfterFailure(t *testing.T) {
	projectDir := t.TempDir()
	want := errors.New("mutation failed")
	err := With(context.Background(), projectDir, Options{}, func(context.Context) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("With() error = %v, want %v", err, want)
	}
	if Exists(projectDir) {
		t.Fatal("lock remains after failure")
	}
}

func TestWithReleasesAfterPanic(t *testing.T) {
	projectDir := t.TempDir()
	func() {
		defer func() { _ = recover() }()
		_ = With(context.Background(), projectDir, Options{}, func(context.Context) error {
			panic("mutation panicked")
		})
	}()
	if Exists(projectDir) {
		t.Fatal("lock remains after panic")
	}
}

func TestAcquireHonorsContext(t *testing.T) {
	projectDir := t.TempDir()
	handle, err := Acquire(context.Background(), projectDir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer Release(handle)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := Acquire(ctx, projectDir, Options{MaxRetries: 50, Retry: time.Second}); err == nil {
		t.Fatal("Acquire() ignored context cancellation")
	}
}
