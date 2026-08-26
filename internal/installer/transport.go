package installer

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sori883/aidlc/internal/distribution"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/version"
)

type TransportOptions struct {
	ReleaseRoot string
	ProjectRoot string
	Client      *http.Client
	HostGOOS    string
	HostGOARCH  string
	Smoke       func(context.Context, []byte, distribution.Target, string) error
}

func Download(ctx context.Context, options TransportOptions) (DownloadedDistribution, error) {
	releaseRoot := strings.TrimSuffix(options.ReleaseRoot, "/")
	if releaseRoot == "" {
		releaseRoot = "https://github.com/" + distribution.Repository + "/releases/download/v" + version.Version
	}
	projectRoot := strings.TrimSuffix(options.ProjectRoot, "/")
	if projectRoot == "" {
		projectRoot = "https://raw.githubusercontent.com/" + distribution.Repository + "/v" + version.Version + "/" + distribution.ProjectRoot
	}
	client := options.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	checksums, err := fetch(ctx, client, releaseRoot+"/"+distribution.ChecksumsAsset, "", -1, 4*1024*1024)
	if err != nil {
		return DownloadedDistribution{}, err
	}
	manifestExpected, err := checksumFor(checksums, distribution.ManifestAsset)
	if err != nil {
		return DownloadedDistribution{}, err
	}
	manifestBytes, err := fetch(ctx, client, releaseRoot+"/"+distribution.ManifestAsset, manifestExpected, -1, 8*1024*1024)
	if err != nil {
		return DownloadedDistribution{}, err
	}
	manifest, err := jsonx.Decode[distribution.Manifest](manifestBytes)
	if err != nil {
		return DownloadedDistribution{}, fmt.Errorf("Distribution manifest is not valid strict JSON: %w", err)
	}
	if err := manifest.Validate(version.Version); err != nil {
		return DownloadedDistribution{}, err
	}
	hostGOOS, hostGOARCH := options.HostGOOS, options.HostGOARCH
	if hostGOOS == "" {
		hostGOOS = runtime.GOOS
	}
	if hostGOARCH == "" {
		hostGOARCH = runtime.GOARCH
	}
	hostTarget, err := distribution.HostTarget(hostGOOS, hostGOARCH)
	if err != nil {
		return DownloadedDistribution{}, err
	}
	var hostRecord distribution.BinaryRecord
	sources := make([]SourceFile, len(manifest.Files)+len(manifest.Binaries))
	type job struct {
		index int
		url   string
		path  string
		sha   string
		bytes int64
		exec  bool
	}
	jobs := make([]job, 0, len(sources))
	for index, file := range manifest.Files {
		jobs = append(jobs, job{index: index, url: projectRoot + "/" + encodePath(file.Path), path: file.Path, sha: file.SHA256, bytes: file.Bytes, exec: file.Executable})
	}
	for index, binary := range manifest.Binaries {
		jobs = append(jobs, job{index: len(manifest.Files) + index, url: releaseRoot + "/" + url.PathEscape(binary.Asset), path: binary.ProjectPath, sha: binary.SHA256, bytes: binary.Bytes, exec: binary.GOOS != "windows"})
		if binary.Target == hostTarget.Name {
			hostRecord = binary
		}
	}
	if hostRecord.Target == "" {
		return DownloadedDistribution{}, fmt.Errorf("Distribution manifest does not contain host target %s", hostTarget.Name)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan job)
	var firstErr error
	var mutex sync.Mutex
	var workers sync.WaitGroup
	for worker := 0; worker < min(8, len(jobs)); worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for item := range work {
				if ctx.Err() != nil {
					continue
				}
				content, fetchErr := fetch(ctx, client, item.url, item.sha, item.bytes, item.bytes)
				if fetchErr != nil {
					mutex.Lock()
					if firstErr == nil {
						firstErr = fetchErr
						cancel()
					}
					mutex.Unlock()
					continue
				}
				sources[item.index] = SourceFile{Path: item.path, Content: content, SHA256: item.sha, Executable: item.exec}
			}
		}()
	}
	for _, item := range jobs {
		if ctx.Err() != nil {
			break
		}
		work <- item
	}
	close(work)
	workers.Wait()
	if firstErr != nil {
		return DownloadedDistribution{}, firstErr
	}
	var hostContent []byte
	for _, source := range sources {
		if source.Path == hostRecord.ProjectPath {
			hostContent = source.Content
			break
		}
	}
	smoke := options.Smoke
	if smoke == nil {
		smoke = smokeDownloaded
	}
	if err := smoke(ctx, hostContent, hostTarget, version.Version); err != nil {
		return DownloadedDistribution{}, err
	}
	sort.Slice(sources, func(left, right int) bool { return sources[left].Path < sources[right].Path })
	return DownloadedDistribution{Manifest: manifest, HostBinary: hostRecord, Files: sources}, nil
}

func fetch(ctx context.Context, client *http.Client, location, expected string, expectedBytes, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "aidlc-installer/"+version.Version)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download failed (%d): %s", response.StatusCode, location)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > limit {
		return nil, fmt.Errorf("download exceeds expected size for %s", location)
	}
	if expectedBytes >= 0 && int64(len(content)) != expectedBytes {
		return nil, fmt.Errorf("downloaded size mismatch for %s", location)
	}
	if expected != "" && distribution.SHA256(content) != expected {
		return nil, fmt.Errorf("downloaded size or SHA-256 mismatch for %s", location)
	}
	return content, nil
}

func checksumFor(content []byte, asset string) (string, error) {
	for _, line := range strings.Split(strings.TrimSpace(string(content)), "\n") {
		sha, name, ok := strings.Cut(line, "  ")
		if ok && name == asset && len(sha) == 64 && isLowerHex(sha) {
			return sha, nil
		}
	}
	return "", fmt.Errorf("SHA256SUMS does not contain %s", asset)
}

func isLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func encodePath(path string) string {
	parts := strings.Split(path, "/")
	for index := range parts {
		parts[index] = url.PathEscape(parts[index])
	}
	return strings.Join(parts, "/")
}

func smokeDownloaded(ctx context.Context, content []byte, target distribution.Target, expectedVersion string) error {
	directory, err := os.MkdirTemp("", "aidlc-installer-smoke-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	name := "aidlc"
	if target.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, content, 0o755); err != nil {
		return err
	}
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = []string{"PATH="}
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "aidlc "+expectedVersion+"\n" {
		return fmt.Errorf("downloaded native CLI failed verification: %w: %s", err, output)
	}
	return nil
}
