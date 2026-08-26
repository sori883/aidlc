package audit

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/workspace"
)

func TestAppendUsesMonotonicSequenceAndCanonicalFields(t *testing.T) {
	projectDir, recordDir := auditFixture(t)
	clock := func() time.Time { return time.Date(2026, 8, 26, 1, 2, 3, 456789000, time.UTC) }
	first, err := Append(context.Background(), projectDir, recordDir, DecisionRecorded, []Field{{Name: "Decision", Value: "one"}}, clock)
	if err != nil {
		t.Fatal(err)
	}
	batch, err := AppendBatch(context.Background(), projectDir, recordDir, []BatchEntry{
		{Event: QuestionAnswered, Fields: []Field{{Name: "Question", Value: "two"}}},
		{Event: RuleLearned, Fields: []Field{{Name: "Rule", Value: "three"}}},
	}, clock)
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || len(batch.Sequences) != 2 || batch.Sequences[0] != 2 || batch.Sequences[1] != 3 {
		t.Fatalf("sequences = %d, %v", first.Sequence, batch.Sequences)
	}
	content, err := os.ReadFile(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	wantFragment := "**Timestamp**: 2026-08-26T01:02:03.456Z\n**Clone ID**: " + first.CloneID + "\n**Sequence**: 1\n**Event**: DECISION_RECORDED\n**Decision**: one\n"
	if !contains(string(content), wantFragment) {
		t.Fatalf("Audit content does not contain canonical block:\n%s", content)
	}
}

func TestReadOrderedUsesCloneAndSequence(t *testing.T) {
	recordDir := t.TempDir()
	auditDir := filepath.Join(recordDir, "audit")
	if err := os.Mkdir(auditDir, 0o755); err != nil {
		t.Fatal(err)
	}
	block := func(clone string, sequence int, timestamp, event string) string {
		return fmt.Sprintf("# AI-DLC Audit Log\n\n## Event\n**Timestamp**: %s\n**Clone ID**: %s\n**Sequence**: %d\n**Event**: %s\n\n---\n", timestamp, clone, sequence, event)
	}
	if err := os.WriteFile(filepath.Join(auditDir, "host-bbbb.md"), []byte(block("bbbb", 1, "2026-08-18T00:00:00.000Z", "WORKFLOW_STARTED")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(auditDir, "host-aaaa.md"), []byte(block("aaaa", 2, "2026-08-18T00:00:02.000Z", "STAGE_COMPLETED")+block("aaaa", 1, "2026-08-18T00:00:01.000Z", "STAGE_STARTED")), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"aaaa:1:STAGE_STARTED", "aaaa:2:STAGE_COMPLETED", "bbbb:1:WORKFLOW_STARTED"}
	for index, entry := range entries {
		got := fmt.Sprintf("%s:%d:%s", entry.CloneID, entry.Sequence, entry.Event)
		if got != want[index] {
			t.Fatalf("entry[%d] = %s, want %s", index, got, want[index])
		}
	}
}

func TestConcurrentAppendsRemainMonotonic(t *testing.T) {
	projectDir, recordDir := auditFixture(t)
	const count = 6
	errors := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, err := Append(context.Background(), projectDir, recordDir, DecisionRecorded, []Field{{Name: "Decision", Value: fmt.Sprint(index)}}, nil)
			errors <- err
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	entries, err := ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != count {
		t.Fatalf("entry count = %d, want %d", len(entries), count)
	}
	for index, entry := range entries {
		if entry.Sequence != index+1 {
			t.Fatalf("sequence[%d] = %d, want %d", index, entry.Sequence, index+1)
		}
	}
}

func TestCloneIDDoesNotFollowSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(projectDir, "aidlc"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("do-not-change\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, CloneIDPath(projectDir)); err != nil {
		t.Fatal(err)
	}
	if value := CloneID(projectDir); !clonePattern.MatchString(value) {
		t.Fatalf("CloneID() = %q", value)
	}
	content, err := os.ReadFile(outside)
	if err != nil || string(content) != "do-not-change\n" {
		t.Fatalf("outside content = %q, %v", content, err)
	}
}

func auditFixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	memoryDir := filepath.Join(projectDir, "memory-source")
	if err := os.Mkdir(memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Initialize(projectDir, memoryDir); err != nil {
		t.Fatal(err)
	}
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "260826-audit")
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}

func contains(value, fragment string) bool {
	return len(value) >= len(fragment) && (value == fragment || len(fragment) == 0 || find(value, fragment) >= 0)
}

func find(value, fragment string) int {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return index
		}
	}
	return -1
}
