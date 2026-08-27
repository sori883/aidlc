// Package sensor runs deterministic, Core-owned checks against Project files
// and Human Gate Artifact references.
package sensor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/format"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
)

const (
	SchemaVersion = 1
	maxFileBytes  = 8 * 1024 * 1024
)

// Trigger controls when a Sensor is eligible to run.
type Trigger string

const (
	TriggerWrite Trigger = "write"
	TriggerGate  Trigger = "gate"
)

// Severity controls whether a failed Gate check may proceed.
type Severity string

const (
	Advisory Severity = "advisory"
	Blocking Severity = "blocking"
)

// Definition describes one built-in deterministic Sensor.
type Definition struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Category    string   `json:"category"`
	Trigger     Trigger  `json:"trigger"`
	Severity    Severity `json:"severity"`
	Description string   `json:"description"`
	Suffixes    []string `json:"suffixes"`
}

var catalog = []Definition{
	{ID: "artifact-reference-integrity", Kind: "deterministic", Category: "artifact-integrity", Trigger: TriggerGate, Severity: Blocking, Description: "Verifies that a Human Gate Artifact reference remains inside the Project and still matches its pinned SHA-256.", Suffixes: []string{}},
	{ID: "go-format", Kind: "deterministic", Category: "code-quality", Trigger: TriggerWrite, Severity: Advisory, Description: "Checks that a Go source file is syntactically valid and already formatted by go/format.", Suffixes: []string{".go"}},
	{ID: "json-valid", Kind: "deterministic", Category: "code-quality", Trigger: TriggerWrite, Severity: Advisory, Description: "Checks that a JSON file contains exactly one valid JSON value.", Suffixes: []string{".json"}},
}

// Options supplies deterministic time in tests.
type Options struct {
	Clock func() time.Time
}

// Request is one exact Sensor evaluation.
type Request struct {
	ProjectDir    string
	RecordDir     string
	Stage         string
	SensorID      string
	Trigger       Trigger
	Path          string
	ExpectedRef   *contract.ArtifactReference
	ObservationID string
}

// Result is the metadata-only outcome of one Sensor request.
type Result struct {
	Observed      bool     `json:"observed"`
	Matched       bool     `json:"matched"`
	Fired         bool     `json:"fired"`
	Skipped       bool     `json:"skipped"`
	Passed        bool     `json:"passed"`
	Blocking      bool     `json:"blocking"`
	SensorID      string   `json:"sensor_id,omitempty"`
	Stage         string   `json:"stage,omitempty"`
	Trigger       Trigger  `json:"trigger,omitempty"`
	Severity      Severity `json:"severity,omitempty"`
	Path          string   `json:"path,omitempty"`
	InputSHA256   string   `json:"input_sha256,omitempty"`
	FireID        string   `json:"fire_id,omitempty"`
	Outcome       string   `json:"outcome,omitempty"`
	FindingCode   string   `json:"finding_code,omitempty"`
	DetailPath    string   `json:"detail_path,omitempty"`
	Deduplicated  bool     `json:"deduplicated"`
	ObservationID string   `json:"observation_id,omitempty"`
}

type ledger struct {
	SchemaVersion int                    `json:"schema_version"`
	Entries       map[string]ledgerEntry `json:"entries"`
	Observations  map[string]observation `json:"observations"`
}

type ledgerEntry struct {
	SensorID     string  `json:"sensor_id"`
	Stage        string  `json:"stage"`
	Trigger      Trigger `json:"trigger"`
	Path         string  `json:"path"`
	InputSHA256  string  `json:"input_sha256"`
	ExpectedSHA  string  `json:"expected_sha256,omitempty"`
	FireID       string  `json:"fire_id"`
	Outcome      string  `json:"outcome"`
	FindingCode  string  `json:"finding_code,omitempty"`
	DetailPath   string  `json:"detail_path,omitempty"`
	LastFiredAt  string  `json:"last_fired_at"`
	LastObserved string  `json:"last_observed_at"`
}

type observation struct {
	Handler       string `json:"handler"`
	SourceEvent   string `json:"source_event"`
	Stage         string `json:"stage"`
	ObservationID string `json:"observation_id,omitempty"`
	Matched       int    `json:"matched"`
	Fired         int    `json:"fired"`
	ObservedAt    string `json:"observed_at"`
}

type detail struct {
	SchemaVersion int      `json:"schema_version"`
	FireID        string   `json:"fire_id"`
	SensorID      string   `json:"sensor_id"`
	Stage         string   `json:"stage"`
	Trigger       Trigger  `json:"trigger"`
	Severity      Severity `json:"severity"`
	Path          string   `json:"path"`
	InputSHA256   string   `json:"input_sha256"`
	Outcome       string   `json:"outcome"`
	FindingCode   string   `json:"finding_code,omitempty"`
	Message       string   `json:"message,omitempty"`
	ObservedAt    string   `json:"observed_at"`
}

// List returns the immutable built-in Sensor catalog.
func List() []Definition {
	result := append([]Definition(nil), catalog...)
	for index := range result {
		result[index].Suffixes = append([]string(nil), result[index].Suffixes...)
	}
	return result
}

// Describe returns one built-in Sensor definition.
func Describe(id string) (Definition, bool) {
	for _, definition := range catalog {
		if definition.ID == id {
			definition.Suffixes = append([]string(nil), definition.Suffixes...)
			return definition, true
		}
	}
	return Definition{}, false
}

// MatchWrite returns the write-triggered Sensors applicable to path.
func MatchWrite(path string) []Definition {
	portable := filepath.ToSlash(path)
	var result []Definition
	for _, definition := range catalog {
		if definition.Trigger != TriggerWrite {
			continue
		}
		for _, suffix := range definition.Suffixes {
			if strings.HasSuffix(strings.ToLower(portable), strings.ToLower(suffix)) {
				result = append(result, definition)
				break
			}
		}
	}
	return result
}

// Fire evaluates one exact Sensor request and appends a paired Core Audit row.
// Repeating the same Sensor, Stage, path, and input bytes is deterministic and
// does not execute or append another pair.
func Fire(ctx context.Context, request Request, options Options) (Result, error) {
	definition, ok := Describe(request.SensorID)
	if !ok {
		return Result{}, fmt.Errorf("unknown Sensor: %s", request.SensorID)
	}
	if request.Trigger != definition.Trigger {
		return Result{}, fmt.Errorf("Sensor %s fires on %s, not %s", definition.ID, definition.Trigger, request.Trigger)
	}
	projectRoot, recordRoot, err := roots(request.ProjectDir, request.RecordDir)
	if err != nil {
		return Result{}, err
	}
	if err := validateStage(request.Stage); err != nil {
		return Result{}, err
	}
	portable, absolute, err := resolvePath(projectRoot, request.Path, true)
	if err != nil {
		return Result{}, err
	}
	if definition.Trigger == TriggerWrite && !matches(definition, portable) {
		return Result{Observed: true, SensorID: definition.ID, Stage: request.Stage, Trigger: request.Trigger, Severity: definition.Severity, Path: portable, ObservationID: request.ObservationID}, nil
	}
	if request.ExpectedRef != nil {
		if err := request.ExpectedRef.Validate(); err != nil {
			return Result{}, fmt.Errorf("Sensor expected Artifact reference: %w", err)
		}
		if request.ExpectedRef.SourceOfTruth != portable {
			return Result{}, fmt.Errorf("Sensor path does not match expected Artifact reference")
		}
	}

	result := Result{Observed: true, Matched: true, SensorID: definition.ID, Stage: request.Stage, Trigger: request.Trigger, Severity: definition.Severity, Blocking: definition.Severity == Blocking, Path: portable, ObservationID: request.ObservationID}
	err = lock.With(ctx, projectRoot, lock.Options{}, func(lockContext context.Context) error {
		content, inputSHA, readOutcome, readCode, readMessage := readInput(absolute)
		expectedSHA := ""
		if request.ExpectedRef != nil && readCode == "" && inputSHA != request.ExpectedRef.SHA256 {
			readOutcome, readCode, readMessage = "failed", "artifact_sha256_mismatch", "Artifact bytes do not match the pinned SHA-256."
		}
		if request.ExpectedRef != nil {
			expectedSHA = request.ExpectedRef.SHA256
		}
		result.InputSHA256 = inputSHA
		key := ledgerKey(definition.ID, request.Stage, request.Trigger, portable)
		value, err := readLedger(recordRoot)
		if err != nil {
			return err
		}
		if prior, exists := value.Entries[key]; exists && digestIsAvailable(inputSHA) && prior.InputSHA256 == inputSHA && prior.ExpectedSHA == expectedSHA {
			result.Skipped = true
			result.Deduplicated = true
			result.Passed = prior.Outcome == "passed"
			result.FireID = prior.FireID
			result.Outcome = prior.Outcome
			result.FindingCode = prior.FindingCode
			result.DetailPath = prior.DetailPath
			return nil
		}

		outcome, findingCode, message := readOutcome, readCode, readMessage
		if findingCode == "" {
			outcome, findingCode, message = evaluate(definition.ID, content)
		}
		fireID := makeFireID(definition.ID, request.Stage, request.Trigger, portable, inputSHA, expectedSHA, outcome, findingCode)
		observedAt := iso(now(options.Clock))
		detailPath := ""
		if outcome != "passed" {
			detailPath, err = writeDetail(projectRoot, recordRoot, detail{
				SchemaVersion: SchemaVersion, FireID: fireID, SensorID: definition.ID,
				Stage: request.Stage, Trigger: request.Trigger, Severity: definition.Severity,
				Path: portable, InputSHA256: inputSHA, Outcome: outcome,
				FindingCode: findingCode, Message: message, ObservedAt: observedAt,
			})
			if err != nil {
				return err
			}
		}
		terminal := audit.SensorPassed
		if outcome == "failed" {
			terminal = audit.SensorFailed
		} else if outcome == "budget-override" {
			terminal = audit.SensorBudgetOverride
		}
		fields := []audit.Field{
			{Name: "Sensor ID", Value: definition.ID}, {Name: "Fire ID", Value: fireID},
			{Name: "Stage", Value: request.Stage}, {Name: "Trigger", Value: string(request.Trigger)},
			{Name: "Severity", Value: string(definition.Severity)}, {Name: "Path", Value: portable},
			{Name: "Input SHA-256", Value: inputSHA},
		}
		if expectedSHA != "" {
			fields = append(fields, audit.Field{Name: "Expected SHA-256", Value: expectedSHA})
		}
		terminalFields := []audit.Field{
			{Name: "Sensor ID", Value: definition.ID}, {Name: "Fire ID", Value: fireID},
			{Name: "Stage", Value: request.Stage}, {Name: "Result", Value: outcome},
			{Name: "Finding Code", Value: findingCode}, {Name: "Detail", Value: detailPath},
			{Name: "Decision Authority", Value: "sensor"},
		}
		if _, err := audit.AppendBatch(lockContext, projectRoot, recordRoot, []audit.BatchEntry{{Event: audit.SensorFired, Fields: fields}, {Event: terminal, Fields: terminalFields}}, options.Clock); err != nil {
			return err
		}
		value.Entries[key] = ledgerEntry{SensorID: definition.ID, Stage: request.Stage, Trigger: request.Trigger, Path: portable, InputSHA256: inputSHA, ExpectedSHA: expectedSHA, FireID: fireID, Outcome: outcome, FindingCode: findingCode, DetailPath: detailPath, LastFiredAt: observedAt, LastObserved: observedAt}
		if err := writeLedger(recordRoot, value); err != nil {
			return err
		}
		result.Fired = true
		result.Passed = outcome == "passed"
		result.FireID = fireID
		result.Outcome = outcome
		result.FindingCode = findingCode
		result.DetailPath = detailPath
		return nil
	})
	return result, err
}

// FireReference runs the mandatory Human Gate Artifact binding Sensor.
func FireReference(ctx context.Context, projectDir, recordDir, stage string, reference contract.ArtifactReference, options Options) (Result, error) {
	return Fire(ctx, Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: stage, SensorID: "artifact-reference-integrity", Trigger: TriggerGate, Path: reference.SourceOfTruth, ExpectedRef: &reference}, options)
}

// RecordObservation records a metadata-only Sensor hook invocation, including
// valid invocations where no path matched. Doctor uses this separately from
// actual SENSOR_FIRED evidence.
func RecordObservation(ctx context.Context, projectDir, recordDir, handler, sourceEvent, stage, observationID string, matched, fired int, options Options) error {
	projectRoot, recordRoot, err := roots(projectDir, recordDir)
	if err != nil {
		return err
	}
	if err := validateStage(stage); err != nil {
		return err
	}
	if handler == "" || sourceEvent == "" || matched < 0 || fired < 0 || fired > matched {
		return fmt.Errorf("invalid Sensor observation")
	}
	return lock.With(ctx, projectRoot, lock.Options{}, func(context.Context) error {
		value, err := readLedger(recordRoot)
		if err != nil {
			return err
		}
		key := handler + "\x00" + sourceEvent
		value.Observations[key] = observation{Handler: handler, SourceEvent: sourceEvent, Stage: stage, ObservationID: observationID, Matched: matched, Fired: fired, ObservedAt: iso(now(options.Clock))}
		return writeLedger(recordRoot, value)
	})
}

// Status summarizes Sensor hook observations and last terminal results.
type Status struct {
	Present      bool          `json:"present"`
	Entries      []ledgerEntry `json:"entries"`
	Observations []observation `json:"observations"`
}

// Inspect reads Sensor health without changing Project state.
func Inspect(recordDir string) (Status, error) {
	path := ledgerPath(recordDir)
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return Status{Entries: []ledgerEntry{}, Observations: []observation{}}, nil
		}
		return Status{}, err
	}
	value, err := readLedger(recordDir)
	if err != nil {
		return Status{}, err
	}
	status := Status{Present: true, Entries: make([]ledgerEntry, 0, len(value.Entries)), Observations: make([]observation, 0, len(value.Observations))}
	for _, entry := range value.Entries {
		status.Entries = append(status.Entries, entry)
	}
	for _, item := range value.Observations {
		status.Observations = append(status.Observations, item)
	}
	sort.Slice(status.Entries, func(i, j int) bool {
		return ledgerKey(status.Entries[i].SensorID, status.Entries[i].Stage, status.Entries[i].Trigger, status.Entries[i].Path) < ledgerKey(status.Entries[j].SensorID, status.Entries[j].Stage, status.Entries[j].Trigger, status.Entries[j].Path)
	})
	sort.Slice(status.Observations, func(i, j int) bool {
		return status.Observations[i].Handler+status.Observations[i].SourceEvent < status.Observations[j].Handler+status.Observations[j].SourceEvent
	})
	return status, nil
}

func roots(projectDir, recordDir string) (string, string, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return "", "", err
	}
	projectRoot = filepath.Clean(projectRoot)
	info, err := os.Lstat(projectRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", fmt.Errorf("Sensor Project must be a real directory: %s", projectRoot)
	}
	recordRoot, err := filepath.Abs(recordDir)
	if err != nil {
		return "", "", err
	}
	relative, err := filepath.Rel(projectRoot, filepath.Clean(recordRoot))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", "", fmt.Errorf("Sensor record directory must remain inside the Project")
	}
	info, err = os.Lstat(recordRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", fmt.Errorf("Sensor record directory must be a real directory: %s", recordRoot)
	}
	return projectRoot, filepath.Clean(recordRoot), nil
}

func resolvePath(projectRoot, value string, allowMissing bool) (string, string, error) {
	if value == "" {
		return "", "", fmt.Errorf("Sensor path is required")
	}
	portable := filepath.ToSlash(value)
	if filepath.IsAbs(value) {
		relative, err := filepath.Rel(projectRoot, filepath.Clean(value))
		if err != nil {
			return "", "", err
		}
		portable = filepath.ToSlash(relative)
	}
	if err := fsx.ValidateRelative(portable); err != nil {
		return "", "", fmt.Errorf("Sensor path: %w", err)
	}
	absolute, err := fsx.ResolveUnder(projectRoot, portable, allowMissing)
	if err != nil {
		return "", "", fmt.Errorf("Sensor path: %w", err)
	}
	return portable, absolute, nil
}

func validateStage(stage string) error {
	if stage == "RISK" {
		return nil
	}
	_, err := contract.ParseStageID(stage)
	if err != nil {
		return fmt.Errorf("Sensor Stage: %w", err)
	}
	return nil
}

func matches(definition Definition, path string) bool {
	for _, suffix := range definition.Suffixes {
		if strings.HasSuffix(strings.ToLower(path), strings.ToLower(suffix)) {
			return true
		}
	}
	return false
}

func readInput(path string) ([]byte, string, string, string, string) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", "failed", "file_missing", "Sensor input does not exist."
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, "", "failed", "file_not_regular", "Sensor input must be a regular non-symlink file."
	}
	if info.Size() > maxFileBytes {
		return nil, "sha256:unavailable", "budget-override", "file_too_large", "Sensor input exceeds the fixed 8 MiB budget."
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, "", "failed", "file_unreadable", "Sensor input could not be read."
	}
	return content, digest.Bytes(content), "", "", ""
}

func evaluate(id string, content []byte) (string, string, string) {
	switch id {
	case "artifact-reference-integrity":
		return "passed", "", ""
	case "go-format":
		formatted, err := format.Source(content)
		if err != nil {
			return "failed", "go_syntax_invalid", bounded(err.Error())
		}
		if !bytes.Equal(formatted, content) {
			return "failed", "go_format_mismatch", "Go source differs from go/format output."
		}
		return "passed", "", ""
	case "json-valid":
		decoder := json.NewDecoder(bytes.NewReader(content))
		var value any
		if err := decoder.Decode(&value); err != nil {
			return "failed", "json_invalid", bounded(err.Error())
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return "failed", "json_trailing_value", "JSON input contains a trailing value or invalid trailing bytes."
		}
		return "passed", "", ""
	default:
		return "failed", "sensor_unknown", "Unknown Sensor."
	}
}

func makeFireID(id, stage string, trigger Trigger, path, inputSHA, expectedSHA, outcome, finding string) string {
	value := sha256.Sum256([]byte(strings.Join([]string{id, stage, string(trigger), path, inputSHA, expectedSHA, outcome, finding}, "\x00")))
	return "fire-" + hex.EncodeToString(value[:])[:24]
}

func digestIsAvailable(value string) bool {
	return digest.Validate(value) == nil
}

func ledgerKey(id, stage string, trigger Trigger, path string) string {
	return strings.Join([]string{id, stage, string(trigger), path}, "\x00")
}

func ledgerPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "sensors", "current.json")
}

func readLedger(recordDir string) (ledger, error) {
	path := ledgerPath(recordDir)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return ledger{SchemaVersion: SchemaVersion, Entries: map[string]ledgerEntry{}, Observations: map[string]observation{}}, nil
	}
	if err != nil {
		return ledger{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return ledger{}, fmt.Errorf("Sensor ledger must be a regular non-symlink file")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return ledger{}, err
	}
	value, err := jsonx.Decode[ledger](content)
	if err != nil {
		return ledger{}, fmt.Errorf("Sensor ledger: %w", err)
	}
	if value.SchemaVersion != SchemaVersion || value.Entries == nil || value.Observations == nil {
		return ledger{}, fmt.Errorf("Sensor ledger has an invalid schema identity")
	}
	return value, nil
}

func writeLedger(recordDir string, value ledger) error {
	if err := ensureDir(recordDir, "artifacts/sensors"); err != nil {
		return err
	}
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return err
	}
	return fsx.AtomicWriteFile(ledgerPath(recordDir), content, 0o644)
}

func writeDetail(projectRoot, recordDir string, value detail) (string, error) {
	directoryRelative := filepath.ToSlash(filepath.Join("artifacts", "sensors", "findings", strings.ToLower(strings.ReplaceAll(value.Stage, "-", "")), value.SensorID))
	if err := ensureDir(recordDir, directoryRelative); err != nil {
		return "", err
	}
	directory := filepath.Join(recordDir, filepath.FromSlash(directoryRelative))
	path := filepath.Join(directory, value.FireID+".json")
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return "", err
	}
	info, statErr := os.Lstat(path)
	if statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("immutable Sensor finding must be a regular non-symlink file: %s", path)
		}
		existing, readErr := os.ReadFile(path)
		if readErr != nil {
			return "", readErr
		}
		if !bytes.Equal(existing, content) {
			return "", fmt.Errorf("immutable Sensor finding differs: %s", path)
		}
	} else if !os.IsNotExist(statErr) {
		return "", statErr
	} else if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	relative, err := filepath.Rel(projectRoot, path)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(relative), nil
}

func ensureDir(recordDir, relative string) error {
	_, err := fsx.EnsureDirUnder(recordDir, relative, 0o755)
	return err
}

func now(clock func() time.Time) time.Time {
	if clock != nil {
		return clock()
	}
	return time.Now()
}

func iso(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func bounded(value string) string {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " ")
	value = strings.TrimSpace(value)
	if len(value) > 512 {
		value = value[:512]
	}
	return value
}

// String renders a stable one-line catalog description used by the CLI.
func (definition Definition) String() string {
	return strings.Join([]string{definition.ID, definition.Kind, string(definition.Trigger), string(definition.Severity), strconv.Quote(definition.Description)}, "\t")
}
