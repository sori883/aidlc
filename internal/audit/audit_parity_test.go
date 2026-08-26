package audit

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"testing"
)

func TestAuditBytesMatchTypeScriptAfterNondeterminismNormalization(t *testing.T) {
	t.Parallel()
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun is unavailable for differential parity")
	}
	repoRoot := repositoryRoot(t)
	goProject, goRecord := bareAuditProject(t)
	tsProject, tsRecord := bareAuditProject(t)
	if _, err := Append(context.Background(), goProject, goRecord, DecisionRecorded, []Field{{Name: "Decision", Value: "one"}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := AppendBatch(context.Background(), goProject, goRecord, []BatchEntry{
		{Event: QuestionAnswered, Fields: []Field{{Name: "Question", Value: "two"}}},
		{Event: RuleLearned, Fields: []Field{{Name: "Rule", Value: "three"}}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	script := "import { appendAuditEntry, appendAuditEntries } from './core/tools/aidlc-audit.ts';" +
		"appendAuditEntry(" + strconv.Quote(tsProject) + "," + strconv.Quote(tsRecord) + ",'DECISION_RECORDED',{Decision:'one'});" +
		"appendAuditEntries(" + strconv.Quote(tsProject) + "," + strconv.Quote(tsRecord) + ",[{event:'QUESTION_ANSWERED',fields:{Question:'two'}},{event:'RULE_LEARNED',fields:{Rule:'three'}}]);"
	command := exec.Command(bun, "-e", script)
	command.Dir = repoRoot
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("TypeScript Audit fixture failed: %v: %s", err, output)
	}
	goContent := onlyAuditShard(t, goRecord)
	tsContent := onlyAuditShard(t, tsRecord)
	if got, want := normalizeAudit(goContent), normalizeAudit(tsContent); got != want {
		t.Fatalf("normalized Go Audit differs from TypeScript\nGo:\n%s\nTypeScript:\n%s", got, want)
	}
}

func bareAuditProject(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "fixture")
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}

func onlyAuditShard(t *testing.T, recordDir string) string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(recordDir, "audit", "*.md"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("Audit shards = %v, %v", matches, err)
	}
	content, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func normalizeAudit(content string) string {
	timestamp := regexp.MustCompile(`(?m)^(\*\*Timestamp\*\*: ).*$`)
	clone := regexp.MustCompile(`(?m)^(\*\*Clone ID\*\*: ).*$`)
	content = timestamp.ReplaceAllString(content, `${1}<TIMESTAMP>`)
	return clone.ReplaceAllString(content, `${1}<CLONE>`)
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}
