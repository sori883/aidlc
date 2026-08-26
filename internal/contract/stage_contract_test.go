package contract

import (
	"bytes"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/platform/jsonx"
)

func artifactReference(name string) ArtifactReference {
	return ArtifactReference{Artifact: name, Version: 1, SourceOfTruth: "records/" + name + ".md", SHA256: "sha256:" + strings.Repeat("a", 64)}
}

func validPlan() StageExecutionPlan {
	decisions := make([]CoreStageDecision, 0, len(OrderedStageIDs))
	for _, stageID := range OrderedStageIDs {
		decisions = append(decisions, CoreStageDecision{
			SchemaVersion: 1, DecisionID: "decision-" + string(stageID), StageID: stageID,
			Disposition: Execute, Reason: "Core selected execute.", Evidence: []ArtifactReference{}, DecisionAuthority: "core",
		})
	}
	return StageExecutionPlan{
		SchemaVersion: 1, IntentID: "intent-123", Revision: 1, GraphVersion: "vnext-10-stage-graph-v1",
		PolicySnapshot: artifactReference("effective-policy"), StageDecisions: decisions,
	}
}

func TestStageExecutionPlanFixedCoverage(t *testing.T) {
	t.Parallel()
	plan := validPlan()
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
	plan.StageDecisions[0], plan.StageDecisions[1] = plan.StageDecisions[1], plan.StageDecisions[0]
	if err := plan.Validate(); err == nil {
		t.Fatal("Validate() accepted reordered Stages")
	}
}

func TestDispositionEvidenceAndAuthority(t *testing.T) {
	t.Parallel()
	proposal := StageDispositionProposal{
		SchemaVersion: 1, ProposalID: "proposal-1", StageID: Stage01, Disposition: Reuse,
		Reason: "Reuse the current map.", Evidence: []ArtifactReference{}, ProposedBy: ProposerAI,
	}
	if err := proposal.Validate(); err == nil {
		t.Fatal("Validate() accepted reuse without Evidence")
	}
	proposal.Evidence = []ArtifactReference{artifactReference("system-map")}
	if err := proposal.Validate(); err != nil {
		t.Fatal(err)
	}
	decision := validPlan().StageDecisions[0]
	decision.DecisionAuthority = "ai"
	if err := decision.Validate(); err == nil {
		t.Fatal("Validate() accepted AI authority")
	}
}

func TestStrictDecodeRejectsUnknownFields(t *testing.T) {
	t.Parallel()
	content := []byte(`{"schema_version":1,"proposal_id":"p1","stage_id":"ST-01","disposition":"execute","reason":"work","evidence":[],"proposed_by":"ai","next_stage":"ST-09"}`)
	if _, err := DecodeStageDispositionProposal(content); err == nil {
		t.Fatal("DecodeStageDispositionProposal() accepted next_stage")
	}
}

func TestArtifactReferenceRejectsNonCanonicalDigest(t *testing.T) {
	t.Parallel()
	value := artifactReference("system-map")
	value.SHA256 = "abc"
	if err := value.Validate(); err == nil {
		t.Fatal("Validate() accepted a non-canonical digest")
	}
}

func TestPlanDecodeRejectsNullProposalReference(t *testing.T) {
	t.Parallel()
	content, err := jsonx.MarshalCanonical(validPlan())
	if err != nil {
		t.Fatal(err)
	}
	content = bytes.Replace(content, []byte(`"decision_authority": "core"`), []byte(`"decision_authority": "core",\n      "proposal_ref": null`), 1)
	if _, err := DecodeStageExecutionPlan(content); err == nil {
		t.Fatal("DecodeStageExecutionPlan() accepted null proposal_ref")
	}
}
