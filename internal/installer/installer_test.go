package installer

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/distribution"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/version"
)

func TestLocalHTTPFreshIdempotentUpdateAndConflict(t *testing.T) {
	projectDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(projectDir, "aidlc"), 0o755); err != nil {
		t.Fatal(err)
	}
	workspacePath := filepath.Join(projectDir, "aidlc", "user-owned.txt")
	if err := os.WriteFile(workspacePath, []byte("preserve me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first := newHTTPFixture(t, map[string]fixtureFile{
		".codex/obsolete.txt": {content: "retire me\n"},
		".codex/tools/aidlc":  {content: "#!/bin/sh\n", executable: true},
		"AGENTS.md":           {content: "first\n"},
	}, "")
	defer first.server.Close()
	options := runOptions(projectDir, first)
	result, err := Run(context.Background(), options)
	if err != nil || len(result.Conflicts) != 0 || len(result.Written) != 8 {
		t.Fatalf("fresh = %+v, %v", result, err)
	}
	if content, _ := os.ReadFile(workspacePath); string(content) != "preserve me\n" {
		t.Fatal("fresh install changed user-owned Workspace")
	}
	previous, err := ReadPrevious(projectDir)
	if err != nil || previous == nil || len(previous.Manifest.Files) != 8 {
		t.Fatalf("previous = %+v, %v", previous, err)
	}

	result, err = Run(context.Background(), options)
	if err != nil || len(result.Written) != 0 || len(result.Unchanged) != 8 {
		t.Fatalf("idempotent = %+v, %v", result, err)
	}

	second := newHTTPFixture(t, map[string]fixtureFile{
		".codex/hooks.json":  {content: "{\"hooks\":{}}\n"},
		".codex/tools/aidlc": {content: "#!/bin/sh\n", executable: true},
		"AGENTS.md":          {content: "second\n"},
	}, "")
	defer second.server.Close()
	updated := runOptions(projectDir, second)
	updated.Command = "update"
	result, err = Run(context.Background(), updated)
	if err != nil || len(result.Conflicts) != 0 || !contains(result.Removed, ".codex/obsolete.txt") || !contains(result.Written, "AGENTS.md") {
		t.Fatalf("update = %+v, %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(projectDir, ".codex", "obsolete.txt")); !os.IsNotExist(err) {
		t.Fatalf("obsolete file remains: %v", err)
	}
	if content, _ := os.ReadFile(workspacePath); string(content) != "preserve me\n" {
		t.Fatal("update changed user-owned Workspace")
	}

	if err := os.WriteFile(filepath.Join(projectDir, "AGENTS.md"), []byte("human edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	third := newHTTPFixture(t, map[string]fixtureFile{
		".codex/hooks.json":  {content: "{\"hooks\":{\"new\":true}}\n"},
		".codex/tools/aidlc": {content: "#!/bin/sh\n", executable: true},
		"AGENTS.md":          {content: "third\n"},
	}, "")
	defer third.server.Close()
	conflicting := runOptions(projectDir, third)
	conflicting.Command = "update"
	result, err = Run(context.Background(), conflicting)
	if err != nil || !contains(result.Conflicts, "AGENTS.md") {
		t.Fatalf("conflict = %+v, %v", result, err)
	}
	if content, _ := os.ReadFile(filepath.Join(projectDir, ".codex", "hooks.json")); string(content) != "{\"hooks\":{}}\n" {
		t.Fatal("conflicted update partially wrote another managed file")
	}
}

func TestTransportTamperAndSymlinkFailClosedWithoutWorkspaceWrites(t *testing.T) {
	tampered := newHTTPFixture(t, map[string]fixtureFile{"AGENTS.md": {content: "safe\n"}}, "/release/aidlc-darwin-arm64")
	defer tampered.server.Close()
	projectDir := filepath.Join(t.TempDir(), "new-project")
	if _, err := Run(context.Background(), runOptions(projectDir, tampered)); err == nil {
		t.Fatal("tampered binary was accepted")
	}
	if _, err := os.Stat(projectDir); !os.IsNotExist(err) {
		t.Fatalf("failed download created Project: %v", err)
	}

	safe := newHTTPFixture(t, map[string]fixtureFile{
		".codex/tools/aidlc": {content: "#!/bin/sh\n", executable: true},
		"AGENTS.md":          {content: "safe\n"},
	}, "")
	defer safe.server.Close()
	unsafeProject := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(unsafeProject, ".codex")); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), runOptions(unsafeProject, safe)); err == nil {
		t.Fatal("Installer accepted a symlink ancestor")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("symlink target changed: %v, %v", entries, err)
	}
}

func TestPlanRejectsUserWorkspaceSource(t *testing.T) {
	content := []byte("bad")
	if _, err := PlanInstallation([]SourceFile{{Path: "aidlc/state.json", Content: content, SHA256: distribution.SHA256(content)}}, nil, func(string) PathState { return PathState{Kind: "missing"} }); err == nil {
		t.Fatal("Installer accepted a user Workspace source")
	}
}

func TestChecksumParserRequiresLowercaseSHA256(t *testing.T) {
	asset := distribution.ManifestAsset
	if _, err := checksumFor([]byte(strings.Repeat("g", 64)+"  "+asset+"\n"), asset); err == nil {
		t.Fatal("checksum parser accepted a non-hex digest")
	}
	if _, err := checksumFor([]byte(strings.Repeat("A", 64)+"  "+asset+"\n"), asset); err == nil {
		t.Fatal("checksum parser accepted an uppercase digest")
	}
}

type fixtureFile struct {
	content    string
	executable bool
}

type httpFixture struct {
	server *httptest.Server
}

func newHTTPFixture(t *testing.T, files map[string]fixtureFile, tamperPath string) httpFixture {
	t.Helper()
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	responses := map[string][]byte{}
	records := make([]distribution.FileRecord, 0, len(paths))
	for _, path := range paths {
		file := files[path]
		content := []byte(file.content)
		records = append(records, distribution.FileRecord{Path: path, SHA256: distribution.SHA256(content), Bytes: int64(len(content)), Executable: file.executable, Area: "harness"})
		responses["/project/"+path] = content
	}
	binaries := make([]distribution.BinaryRecord, 0, len(distribution.Targets))
	for _, target := range distribution.Targets {
		content := []byte("fixture-" + target.Name)
		binaries = append(binaries, distribution.BinaryRecord{Target: target.Name, Asset: target.Asset, ProjectPath: target.ProjectPath, SHA256: distribution.SHA256(content), Bytes: int64(len(content)), GOOS: target.GOOS, GOARCH: target.GOARCH, Format: target.Format})
		responses["/release/"+target.Asset] = content
	}
	manifest := distribution.Manifest{Format: distribution.ManifestFormat, SchemaVersion: distribution.ManifestSchema, Version: version.Version, Repository: distribution.Repository, Tag: "v" + version.Version, ProjectRoot: distribution.ProjectRoot, Files: records, Binaries: binaries}
	if err := manifest.Validate(version.Version); err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := jsonx.MarshalCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	responses["/release/"+distribution.ManifestAsset] = manifestBytes
	responses["/release/"+distribution.ChecksumsAsset] = []byte(distribution.SHA256(manifestBytes) + "  " + distribution.ManifestAsset + "\n")
	if tamperPath != "" {
		responses[tamperPath] = append(responses[tamperPath], []byte("tamper")...)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		content, ok := responses[request.URL.Path]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		_, _ = writer.Write(content)
	}))
	return httpFixture{server: server}
}

func runOptions(projectDir string, fixture httpFixture) Options {
	return Options{Command: "install", ProjectDir: projectDir, Harness: "codex", InstalledAt: "2026-08-26T00:00:00.000Z", Transport: TransportOptions{ReleaseRoot: fixture.server.URL + "/release", ProjectRoot: fixture.server.URL + "/project", HostGOOS: "darwin", HostGOARCH: "arm64", Smoke: func(context.Context, []byte, distribution.Target, string) error { return nil }}}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
