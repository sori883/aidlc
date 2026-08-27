package humanapproval

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/sensor"
	"github.com/sori883/aidlc/internal/workflow/policy"
)

func RootDir(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "human-approval")
}

func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }

func FreezePath(recordDir, freezeID string) string {
	return filepath.Join(RootDir(recordDir), "freezes", freezeID, "freeze.json")
}

func EnvelopePath(recordDir, freezeID, envelopeID string) string {
	return filepath.Join(RootDir(recordDir), "freezes", freezeID, "envelopes", envelopeID, "envelope.json")
}

func DecisionReviewPath(recordDir, freezeID, envelopeID string) string {
	return filepath.Join(RootDir(recordDir), "freezes", freezeID, "envelopes", envelopeID, "review.html")
}

func ReceiptPath(recordDir, freezeID, receiptID string) string {
	return filepath.Join(RootDir(recordDir), "freezes", freezeID, "receipts", receiptID+".json")
}

func ResolutionPath(recordDir, freezeID string) string {
	return filepath.Join(RootDir(recordDir), "freezes", freezeID, "resolution.json")
}

// Open creates or idempotently reuses one pending immutable Review Freeze.
// A different review cannot replace an unresolved Freeze.
func Open(ctx context.Context, projectDir, recordDir string, options OpenOptions) (OpenResult, error) {
	if err := verifyGateReferencesWithSensors(ctx, projectDir, recordDir, options); err != nil {
		return OpenResult{}, err
	}
	var result OpenResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		var err error
		result, err = openLocked(projectDir, recordDir, options, rand.Reader)
		return err
	})
	return result, err
}

func verifyGateReferencesWithSensors(ctx context.Context, projectDir, recordDir string, options OpenOptions) error {
	references := []struct {
		name      string
		reference contract.ArtifactReference
	}{{name: "subject", reference: options.SubjectRef}, {name: "review", reference: options.ReviewRef}}
	if options.GateRequirementRef != nil {
		references = append(references, struct {
			name      string
			reference contract.ArtifactReference
		}{name: "requirements", reference: *options.GateRequirementRef})
	}
	clock := gateSensorClock(options.OpenedAt)
	for _, item := range references {
		result, err := sensor.FireReference(ctx, projectDir, recordDir, options.Scope, item.reference, sensor.Options{Clock: clock})
		if err != nil {
			return fmt.Errorf("Human Gate %s Sensor: %w", item.name, err)
		}
		if !result.Passed {
			return fmt.Errorf("Human Gate %s Sensor failed: %s", item.name, result.FindingCode)
		}
	}
	return nil
}

func gateSensorClock(value string) func() time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return func() time.Time { return parsed }
}

func openLocked(projectDir, recordDir string, options OpenOptions, random io.Reader) (OpenResult, error) {
	if err := validateIdentity(options.IntentID, options.Scope); err != nil {
		return OpenResult{}, err
	}
	if err := options.SubjectRef.Validate(); err != nil {
		return OpenResult{}, fmt.Errorf("subject_ref: %w", err)
	}
	if err := options.ReviewRef.Validate(); err != nil {
		return OpenResult{}, fmt.Errorf("review_ref: %w", err)
	}
	if options.GateRequirementRef != nil {
		if err := options.GateRequirementRef.Validate(); err != nil {
			return OpenResult{}, fmt.Errorf("gate_requirement_ref: %w", err)
		}
	}
	if err := oneLine(options.GraphVersion, "graph_version"); err != nil {
		return OpenResult{}, err
	}
	if options.PlanRevision < 1 {
		return OpenResult{}, fmt.Errorf("plan_revision must be positive")
	}
	actions, err := normalizedActions(options.AllowedActions)
	if err != nil {
		return OpenResult{}, err
	}
	openedAt := options.OpenedAt
	if openedAt == "" {
		openedAt = now()
	}
	if err := timestamp(openedAt, "opened_at"); err != nil {
		return OpenResult{}, err
	}

	current, exists, err := readCurrentIfExists(projectDir, recordDir)
	if err != nil {
		return OpenResult{}, err
	}
	if exists && current.Status == StatusPending {
		freeze, freezeRef, err := readFreeze(projectDir, current.FreezeRef)
		if err != nil {
			return OpenResult{}, err
		}
		if freeze.IntentID != options.IntentID || freeze.Scope != options.Scope ||
			freeze.SubjectRef != options.SubjectRef || freeze.ReviewRef != options.ReviewRef ||
			!equalOptionalRef(freeze.GateRequirementRef, options.GateRequirementRef) ||
			freeze.GraphVersion != options.GraphVersion || freeze.PlanRevision != options.PlanRevision ||
			!reflect.DeepEqual(freeze.AllowedActions, actions) {
			return OpenResult{}, fmt.Errorf("Human Gate: a different Review Freeze is still awaiting explicit human resolution")
		}
		if err := verifyFreezeBytes(projectDir, freeze); err != nil {
			return OpenResult{}, err
		}
		return OpenResult{Freeze: freeze, FreezeReference: freezeRef, Current: current}, nil
	}

	freezeID, err := randomID(random, "freeze")
	if err != nil {
		return OpenResult{}, err
	}
	confirmationCode, err := randomID(random, "confirm")
	if err != nil {
		return OpenResult{}, err
	}
	frozenSubject, err := snapshot(projectDir, recordDir, freezeID, "subject", options.SubjectRef)
	if err != nil {
		return OpenResult{}, err
	}
	frozenReview, err := snapshot(projectDir, recordDir, freezeID, "review", options.ReviewRef)
	if err != nil {
		return OpenResult{}, err
	}
	var frozenGate *contract.ArtifactReference
	if options.GateRequirementRef != nil {
		value, snapshotErr := snapshot(projectDir, recordDir, freezeID, "gate", *options.GateRequirementRef)
		if snapshotErr != nil {
			return OpenResult{}, snapshotErr
		}
		frozenGate = &value
	}
	freeze := Freeze{
		SchemaVersion: 1, Artifact: "human-review-freeze", Version: 1,
		FreezeID: freezeID, IntentID: options.IntentID, Scope: options.Scope,
		SubjectRef: options.SubjectRef, FrozenSubjectRef: frozenSubject,
		ReviewRef: options.ReviewRef, FrozenReviewRef: frozenReview,
		GateRequirementRef: cloneRef(options.GateRequirementRef), FrozenGateRef: frozenGate,
		GraphVersion: options.GraphVersion, PlanRevision: options.PlanRevision,
		AllowedActions: actions, ConfirmationCode: confirmationCode, OpenedAt: openedAt,
	}
	if err := freeze.Validate(); err != nil {
		return OpenResult{}, err
	}
	freezeRef, _, err := writeCanonicalImmutable(projectDir, FreezePath(recordDir, freezeID), freeze.Artifact, 1, freeze)
	if err != nil {
		return OpenResult{}, err
	}
	current = Current{
		SchemaVersion: 1, Artifact: "human-gate-current", Version: 1,
		IntentID: options.IntentID, Scope: options.Scope, Status: StatusPending,
		FreezeRef: freezeRef, UpdatedAt: openedAt,
	}
	if err := writeCurrent(projectDir, recordDir, current); err != nil {
		return OpenResult{}, err
	}
	return OpenResult{Freeze: freeze, FreezeReference: freezeRef, Current: current}, nil
}

// ReadCurrent loads and verifies the current Freeze and every referenced
// immutable artifact. It returns os.ErrNotExist when no Human Gate exists.
func ReadCurrent(projectDir, recordDir string) (Current, Freeze, contract.ArtifactReference, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Current{}, Freeze{}, contract.ArtifactReference{}, err
	}
	current, exists, err := readCurrentIfExists(projectDir, recordDir)
	if err != nil {
		return Current{}, Freeze{}, contract.ArtifactReference{}, err
	}
	if !exists {
		return Current{}, Freeze{}, contract.ArtifactReference{}, os.ErrNotExist
	}
	freeze, freezeRef, err := readFreeze(projectDir, current.FreezeRef)
	if err != nil {
		return Current{}, Freeze{}, contract.ArtifactReference{}, err
	}
	if current.IntentID != freeze.IntentID || current.Scope != freeze.Scope {
		return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Current does not bind its Freeze")
	}
	if err := verifyFreezeBytes(projectDir, freeze); err != nil {
		return Current{}, Freeze{}, contract.ArtifactReference{}, err
	}
	var envelope Envelope
	if current.EnvelopeRef != nil {
		envelope, _, err = readEnvelope(projectDir, *current.EnvelopeRef)
		if err != nil {
			return Current{}, Freeze{}, contract.ArtifactReference{}, err
		}
		if envelope.FreezeRef != freezeRef || envelope.SubjectRef != freeze.SubjectRef || envelope.IntentID != freeze.IntentID || envelope.Scope != freeze.Scope {
			return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Envelope does not bind its Current and Freeze")
		}
		expectedReview, reviewErr := filepath.Rel(projectRoot, DecisionReviewPath(recordDir, freeze.FreezeID, envelope.EnvelopeID))
		if reviewErr != nil || current.DecisionReview == nil || current.DecisionReview.Artifact != "human-decision-review" || current.DecisionReview.Version != 1 ||
			current.DecisionReview.SourceOfTruth != filepath.ToSlash(expectedReview) {
			return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Decision Review does not bind its Envelope")
		}
	}
	var receipt Receipt
	if current.ReceiptRef != nil {
		receipt, _, err = readReceipt(projectDir, *current.ReceiptRef)
		if err != nil {
			return Current{}, Freeze{}, contract.ArtifactReference{}, err
		}
		if current.EnvelopeRef == nil || receipt.FreezeRef != freezeRef || receipt.EnvelopeRef != *current.EnvelopeRef ||
			receipt.IntentID != freeze.IntentID || receipt.Scope != freeze.Scope || receipt.Action != envelope.Action {
			return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Receipt does not bind its Current, Envelope, and Freeze")
		}
	}
	if current.ResolutionRef != nil {
		resolution, _, resolutionErr := readResolution(projectDir, *current.ResolutionRef)
		if resolutionErr != nil {
			return Current{}, Freeze{}, contract.ArtifactReference{}, resolutionErr
		}
		if current.EnvelopeRef == nil || current.ReceiptRef == nil || resolution.FreezeRef != freezeRef ||
			resolution.EnvelopeRef != *current.EnvelopeRef || resolution.ReceiptRef != *current.ReceiptRef ||
			resolution.IntentID != freeze.IntentID || resolution.Scope != freeze.Scope || resolution.Action != envelope.Action {
			return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Resolution does not bind its Current, Receipt, Envelope, and Freeze")
		}
		if resolution.DecisionRef != nil {
			if _, verifyErr := policy.VerifyProjectArtifactReference(projectDir, *resolution.DecisionRef); verifyErr != nil {
				return Current{}, Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate decision artifact is invalid: %w", verifyErr)
			}
		}
	}
	return current, freeze, freezeRef, nil
}

func readCurrentIfExists(projectDir, recordDir string) (Current, bool, error) {
	path := CurrentPath(recordDir)
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Current{}, false, nil
		}
		return Current{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Current{}, false, fmt.Errorf("Human Gate Current must be a regular file")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Current{}, false, err
	}
	value, err := jsonx.Decode[Current](content)
	if err != nil {
		return Current{}, false, err
	}
	if err := value.Validate(); err != nil {
		return Current{}, false, err
	}
	for _, ref := range []*contract.ArtifactReference{&value.FreezeRef, value.EnvelopeRef, value.DecisionReview, value.ReceiptRef, value.ResolutionRef} {
		if ref == nil {
			continue
		}
		if _, err := policy.VerifyProjectArtifactReference(projectDir, *ref); err != nil {
			return Current{}, false, err
		}
	}
	return value, true, nil
}

func readFreeze(projectDir string, reference contract.ArtifactReference) (Freeze, contract.ArtifactReference, error) {
	path, err := policy.VerifyProjectArtifactReference(projectDir, reference)
	if err != nil {
		return Freeze{}, contract.ArtifactReference{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Freeze{}, contract.ArtifactReference{}, err
	}
	value, err := jsonx.Decode[Freeze](content)
	if err != nil {
		return Freeze{}, contract.ArtifactReference{}, err
	}
	if err := value.Validate(); err != nil {
		return Freeze{}, contract.ArtifactReference{}, err
	}
	if reference.Artifact != value.Artifact || reference.Version != value.Version {
		return Freeze{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Freeze reference identity differs")
	}
	return value, reference, nil
}

func verifyFreezeBytes(projectDir string, freeze Freeze) error {
	for name, pair := range map[string][2]contract.ArtifactReference{
		"subject": {freeze.SubjectRef, freeze.FrozenSubjectRef},
		"review":  {freeze.ReviewRef, freeze.FrozenReviewRef},
	} {
		if _, err := policy.VerifyProjectArtifactReference(projectDir, pair[0]); err != nil {
			return fmt.Errorf("Human Gate %s changed after Review Freeze: %w", name, err)
		}
		if _, err := policy.VerifyProjectArtifactReference(projectDir, pair[1]); err != nil {
			return fmt.Errorf("Human Gate frozen %s is invalid: %w", name, err)
		}
		if pair[0].SHA256 != pair[1].SHA256 {
			return fmt.Errorf("Human Gate frozen %s digest differs", name)
		}
	}
	if freeze.GateRequirementRef != nil {
		if _, err := policy.VerifyProjectArtifactReference(projectDir, *freeze.GateRequirementRef); err != nil {
			return fmt.Errorf("Human Gate requirements changed after Review Freeze: %w", err)
		}
		if _, err := policy.VerifyProjectArtifactReference(projectDir, *freeze.FrozenGateRef); err != nil {
			return fmt.Errorf("Human Gate frozen requirements are invalid: %w", err)
		}
		if freeze.GateRequirementRef.SHA256 != freeze.FrozenGateRef.SHA256 {
			return fmt.Errorf("Human Gate frozen requirements digest differs")
		}
	}
	return nil
}

func snapshot(projectDir, recordDir, freezeID, kind string, source contract.ArtifactReference) (contract.ArtifactReference, error) {
	path, err := policy.VerifyProjectArtifactReference(projectDir, source)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	extension := filepath.Ext(path)
	if extension == "" || len(extension) > 10 {
		extension = ".bin"
	}
	target := filepath.Join(RootDir(recordDir), "freezes", freezeID, "snapshots", kind+extension)
	artifact := "human-review-" + kind + "-snapshot"
	if err := writeImmutable(projectDir, target, content); err != nil {
		return contract.ArtifactReference{}, err
	}
	return reference(projectDir, target, artifact, 1, content)
}

func writeCanonicalImmutable(projectDir, path, artifact string, version int, value any) (contract.ArtifactReference, []byte, error) {
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	if err := writeImmutable(projectDir, path, content); err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	ref, err := reference(projectDir, path, artifact, version, content)
	return ref, content, err
}

func writeImmutable(projectDir, path string, content []byte) error {
	if err := ensureParent(projectDir, path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("immutable Human Gate path is not a regular file: %s", path)
		}
		existing, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if string(existing) != string(content) {
			return fmt.Errorf("immutable Human Gate artifact differs: %s", path)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return fsx.AtomicWriteFile(path, content, 0o644)
}

func writeCurrent(projectDir, recordDir string, value Current) error {
	if err := value.Validate(); err != nil {
		return err
	}
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return err
	}
	path := CurrentPath(recordDir)
	if err := ensureParent(projectDir, path); err != nil {
		return err
	}
	return fsx.AtomicWriteFile(path, content, 0o644)
}

func reference(projectDir, path, artifact string, version int, content []byte) (contract.ArtifactReference, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	relative, err := filepath.Rel(projectRoot, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return contract.ArtifactReference{}, fmt.Errorf("Human Gate artifact must remain inside Project")
	}
	portable := filepath.ToSlash(relative)
	if err := fsx.ValidateRelative(portable); err != nil {
		return contract.ArtifactReference{}, err
	}
	value := contract.ArtifactReference{Artifact: artifact, Version: version, SourceOfTruth: portable, SHA256: digest.Bytes(content)}
	if err := value.Validate(); err != nil {
		return contract.ArtifactReference{}, err
	}
	return value, nil
}

func ensureParent(projectDir, path string) error {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(projectRoot, filepath.Dir(path))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Human Gate parent must remain inside Project")
	}
	_, err = fsx.EnsureDirUnder(projectRoot, filepath.ToSlash(relative), 0o755)
	return err
}

func randomID(reader io.Reader, prefix string) (string, error) {
	content := make([]byte, 16)
	if _, err := io.ReadFull(reader, content); err != nil {
		return "", fmt.Errorf("generate Human Gate %s ID: %w", prefix, err)
	}
	return prefix + "-" + hex.EncodeToString(content), nil
}

func equalOptionalRef(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func cloneRef(value *contract.ArtifactReference) *contract.ArtifactReference {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
