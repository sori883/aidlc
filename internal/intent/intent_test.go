package intent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/workspace"
)

func TestBirthRecordListAndSwitch(t *testing.T) {
	t.Parallel()
	projectDir := intentProject(t)
	options := Options{
		Clock: func() time.Time { return time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC) },
		UUID:  func() (string, error) { return "0198e26a-0000-7000-8000-000000000001", nil },
	}
	first, err := BirthRecord(context.Background(), projectDir, "Payment API", "default", []string{"app"}, options)
	if err != nil {
		t.Fatal(err)
	}
	if first.Slug != "payment-api" || first.DirName != "260826-payment-api" || Active(projectDir, "") != first.DirName {
		t.Fatalf("born = %+v, active=%q", first, Active(projectDir, ""))
	}
	registry := ReadRegistry(projectDir, "")
	if len(registry) != 1 || registry[0].DirName != first.DirName || len(registry[0].Repos) != 1 || registry[0].Repos[0] != "app" {
		t.Fatalf("registry = %+v", registry)
	}
	secondOptions := options
	secondOptions.UUID = func() (string, error) { return "0198e26a-0000-7000-8000-000000000002", nil }
	second, err := BirthRecord(context.Background(), projectDir, "Payment API", "default", nil, secondOptions)
	if err != nil {
		t.Fatal(err)
	}
	if second.DirName != first.DirName+"-2" {
		t.Fatalf("second dir = %q", second.DirName)
	}
	if _, err := Switch(context.Background(), projectDir, "payment-api", "default"); err == nil {
		t.Fatal("Switch() accepted an ambiguous slug")
	}
	selected, err := Switch(context.Background(), projectDir, first.DirName, "default")
	if err != nil || selected.DirName != first.DirName {
		t.Fatalf("Switch() = %+v, %v", selected, err)
	}
}

func TestBirthRejectsInvalidLabels(t *testing.T) {
	t.Parallel()
	projectDir := intentProject(t)
	for _, label := range []string{"switch", "  padded brief  ", "line\nbreak"} {
		if _, err := BirthRecord(context.Background(), projectDir, label, "default", nil, Options{}); err == nil {
			t.Fatalf("BirthRecord(%q) succeeded", label)
		}
	}
}

func TestUUIDV7BitsAndDate(t *testing.T) {
	t.Parallel()
	random := make([]byte, 16)
	for index := range random {
		random[index] = byte(index)
	}
	got := uuidV7From(0x0198e26a0000, random)
	if got != "0198e26a-0000-7607-8809-0a0b0c0d0e0f" {
		t.Fatalf("uuidV7From() = %q", got)
	}
	if DateStamp(time.Date(2026, 8, 26, 23, 0, 0, 0, time.FixedZone("local", 9*60*60))) != "260826" {
		t.Fatal("DateStamp() did not use UTC")
	}
}

func TestWriteDesignBriefIsCanonical(t *testing.T) {
	t.Parallel()
	recordDir := t.TempDir()
	path, err := WriteDesignBrief(recordDir, "intent-1", "Payment API", "2026-08-26T00:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"schema_version\": 1,\n  \"artifact\": \"design-brief\",\n  \"version\": 1,\n  \"intent_id\": \"intent-1\",\n  \"statement\": \"Payment API\",\n  \"created_at\": \"2026-08-26T00:00:00.000Z\"\n}\n"
	if string(content) != want {
		t.Fatalf("brief = %q, want %q", content, want)
	}
}

func intentProject(t *testing.T) string {
	t.Helper()
	projectDir := t.TempDir()
	memoryDir := filepath.Join(projectDir, "memory-source")
	if err := os.Mkdir(memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Initialize(projectDir, memoryDir); err != nil {
		t.Fatal(err)
	}
	return projectDir
}
