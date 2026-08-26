package distribution

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/version"
)

func TestManifestRequiresExactFiveTargetMatrix(t *testing.T) {
	manifest := validManifest()
	if err := manifest.Validate(version.Version); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Manifest){
		"missing target":  func(value *Manifest) { value.Binaries = value.Binaries[:4] },
		"wrong order":     func(value *Manifest) { value.Binaries[0], value.Binaries[1] = value.Binaries[1], value.Binaries[0] },
		"oversize":        func(value *Manifest) { value.Binaries[0].Bytes = MaxBinaryBytes },
		"workspace path":  func(value *Manifest) { value.Files[0].Path = "aidlc/state.json" },
		"TypeScript file": func(value *Manifest) { value.Files[0].Path = "runtime.ts" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := manifest
			candidate.Files = append([]FileRecord{}, manifest.Files...)
			candidate.Binaries = append([]BinaryRecord{}, manifest.Binaries...)
			mutate(&candidate)
			if err := candidate.Validate(version.Version); err == nil {
				t.Fatal("invalid manifest was accepted")
			}
		})
	}
	content, err := jsonx.MarshalCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	content = append(content[:len(content)-2], []byte(",\n  \"unknown\": true\n}\n")...)
	if _, err := jsonx.Decode[Manifest](content); err == nil {
		t.Fatal("unknown manifest field was accepted")
	}
}

func TestInstallationManifestAcceptsPriorLargeBunBinary(t *testing.T) {
	manifest := InstallationManifest{
		Format:        InstallationFormat,
		SchemaVersion: 1,
		Version:       "1.0.0",
		Harness:       "codex",
		InstalledAt:   "2026-08-26T00:00:00.000Z",
		Files: []ManagedFile{{
			Path:       ".codex/tools/aidlc",
			SHA256:     strings.Repeat("a", 64),
			Bytes:      64_288_226,
			Executable: true,
		}},
	}
	if err := manifest.Validate(); err != nil {
		t.Fatalf("prior Bun installation manifest must remain readable: %v", err)
	}
}

func TestPackageBuildsFiveTargetReleaseCandidate(t *testing.T) {
	if testing.Short() {
		t.Skip("cross-build release candidate")
	}
	out := filepath.Join(t.TempDir(), "release")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := Package(ctx, PackageOptions{RepoRoot: repositoryRoot(t), OutputDir: out, Version: version.Version})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifest.Binaries) != 5 || !result.NativeSmoke {
		t.Fatalf("result = %+v", result)
	}
	for _, asset := range append([]string{ManifestAsset, ChecksumsAsset, "install.sh", "install.ps1"}, binaryAssets()...) {
		if info, err := os.Stat(filepath.Join(out, asset)); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("release asset %s: %v", asset, err)
		}
	}
	if !strings.Contains(result.Checksums, result.ManifestSHA256+"  "+ManifestAsset) {
		t.Fatal("checksums do not pin the Distribution Manifest")
	}
	if containsAsset(result.ReleaseAssetSet, ".DS_Store") || len(result.ReleaseAssetSet) != len(Targets)+4 {
		t.Fatalf("release asset set = %v", result.ReleaseAssetSet)
	}
	if _, err := os.Stat(filepath.Join(result.ProjectDir, ".codex", "tools", "aidlc")); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/release/", http.StripPrefix("/release/", http.FileServer(http.Dir(out))))
	mux.Handle("/project/", http.StripPrefix("/project/", http.FileServer(http.Dir(result.ProjectDir))))
	server := httptest.NewServer(mux)
	defer server.Close()
	host, err := HostTarget(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(t.TempDir(), "installed")
	command := exec.Command(filepath.Join(out, host.Asset), "install", "--project", installed, "--json")
	command.Env = []string{"PATH=", "AIDLC_RELEASE_ROOT=" + server.URL + "/release", "AIDLC_RAW_PROJECT_ROOT=" + server.URL + "/project"}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fresh install: %v: %s", err, output)
	}
	var installedResult struct {
		Conflicts []string `json:"conflicts"`
		Written   []string `json:"written"`
	}
	if err := json.Unmarshal(output, &installedResult); err != nil || len(installedResult.Conflicts) != 0 || len(installedResult.Written) != len(result.Manifest.Files)+len(result.Manifest.Binaries) {
		t.Fatalf("install result = %+v, %v: %s", installedResult, err, output)
	}
	installedCommand := filepath.Join(installed, ".codex", "tools", "aidlc")
	commandPath := "/usr/bin:/bin"
	if runtime.GOOS == "windows" {
		installedCommand = filepath.Join(installed, ".codex", "tools", "aidlc.exe")
		commandPath = ""
	}
	smoke := exec.Command(installedCommand, "--version")
	smoke.Env = []string{"PATH=" + commandPath}
	if output, err := smoke.CombinedOutput(); err != nil || string(output) != "aidlc "+version.Version+"\n" {
		t.Fatalf("installed launcher smoke: %v: %s", err, output)
	}
	for _, binary := range result.Manifest.Binaries {
		content, err := os.ReadFile(filepath.Join(installed, filepath.FromSlash(binary.ProjectPath)))
		if err != nil || SHA256(content) != binary.SHA256 {
			t.Fatalf("installed binary %s: %v", binary.Target, err)
		}
	}
	update := exec.Command(installedCommand, "update", "--project", installed, "--json")
	update.Env = []string{"PATH=" + commandPath, "AIDLC_RELEASE_ROOT=" + server.URL + "/release", "AIDLC_RAW_PROJECT_ROOT=" + server.URL + "/project"}
	if output, err := update.CombinedOutput(); err != nil || !strings.Contains(string(output), `"written": []`) {
		t.Fatalf("idempotent installed update: %v: %s", err, output)
	}
	bootstrapProject := filepath.Join(t.TempDir(), "bootstrap-installed")
	var bootstrap *exec.Cmd
	if runtime.GOOS == "windows" {
		bootstrap = exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(out, "install.ps1"), "--project", bootstrapProject, "--json")
	} else {
		bootstrap = exec.Command("sh", filepath.Join(out, "install.sh"), "--project", bootstrapProject, "--json")
	}
	bootstrap.Env = append(os.Environ(), "AIDLC_RELEASE_ROOT="+server.URL+"/release", "AIDLC_RAW_PROJECT_ROOT="+server.URL+"/project")
	if output, err := bootstrap.CombinedOutput(); err != nil {
		t.Fatalf("bootstrap install: %v: %s", err, output)
	}
	if _, err := os.Stat(filepath.Join(bootstrapProject, filepath.FromSlash(host.ProjectPath))); err != nil {
		t.Fatalf("bootstrap did not install host target: %v", err)
	}
	if _, err := Package(ctx, PackageOptions{RepoRoot: repositoryRoot(t), OutputDir: out, Version: version.Version}); err == nil {
		t.Fatal("packager overwrote a non-empty candidate directory")
	}
}

func containsAsset(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func validManifest() Manifest {
	binaries := make([]BinaryRecord, 0, len(Targets))
	for _, target := range Targets {
		binaries = append(binaries, BinaryRecord{Target: target.Name, Asset: target.Asset, ProjectPath: target.ProjectPath, SHA256: strings.Repeat("a", 64), Bytes: 1, GOOS: target.GOOS, GOARCH: target.GOARCH, Format: target.Format})
	}
	return Manifest{Format: ManifestFormat, SchemaVersion: ManifestSchema, Version: version.Version, Repository: Repository, Tag: "v" + version.Version, ProjectRoot: ProjectRoot, Files: []FileRecord{{Path: "AGENTS.md", SHA256: strings.Repeat("b", 64), Bytes: 1, Area: "harness"}}, Binaries: binaries}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func binaryAssets() []string {
	assets := make([]string, 0, len(Targets))
	for _, target := range Targets {
		assets = append(assets, target.Asset)
	}
	return assets
}
