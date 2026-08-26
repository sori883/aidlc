package directive

import (
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
)

func reference(name string) *contract.ArtifactReference {
	return &contract.ArtifactReference{Artifact: name, Version: 1, SourceOfTruth: "aidlc/" + name + ".json", SHA256: "sha256:" + strings.Repeat("a", 64)}
}

func base(kind Kind) Core {
	return Core{SchemaVersion: 1, Workflow: "vnext", Reason: "Core selected the next action.", GraphVersion: "vnext-10-stage-graph-v1", PlanRevision: 1, DecisionAuthority: "core", Kind: kind}
}

func TestAllDirectiveKinds(t *testing.T) {
	t.Parallel()
	stage00, stage01, stage03, stage05, stage08, stage09 := contract.Stage00, contract.Stage01, contract.Stage03, contract.Stage05, contract.Stage08, contract.Stage09
	advanced := base(Advanced)
	advanced.CompletedStage = &stage00
	advanced.Stage = &stage01
	advanced.Evidence = []contract.ArtifactReference{*reference("bootstrap-receipt")}
	work := base(Work)
	work.Stage = &stage03
	work.Request = reference("requirements-work-request")
	approval := base(Approval)
	approval.Stage = &stage05
	approval.Candidate = reference("candidate")
	approval.Review = reference("review")
	approval.Decisions = append([]string(nil), approvalDecisions...)
	decision := base(Decision)
	decision.Stage = &stage09
	decision.Candidate = reference("outcome-evaluation")
	decision.Review = reference("outcome-html")
	decision.Decisions = append([]string(nil), outcomeDecisions...)
	parked := base(Parked)
	parked.Stage = &stage08
	done := base(Done)
	for _, value := range []Core{advanced, work, approval, decision, parked, done} {
		if err := value.Validate(); err != nil {
			t.Fatalf("%s: %v", value.Kind, err)
		}
	}
}

func TestDirectiveRejectsAuthorityAndInventedChoice(t *testing.T) {
	t.Parallel()
	stage := contract.Stage05
	value := base(Approval)
	value.Stage = &stage
	value.Candidate = reference("candidate")
	value.Review = reference("review")
	value.Decisions = []string{"approve", "skip"}
	if err := value.Validate(); err == nil {
		t.Fatal("Validate() accepted invented choice")
	}
	value.Decisions = append([]string(nil), approvalDecisions...)
	value.DecisionAuthority = "ai"
	if err := value.Validate(); err == nil {
		t.Fatal("Validate() accepted AI authority")
	}
}

func TestDirectiveStrictDecodeRejectsRoute(t *testing.T) {
	t.Parallel()
	content := []byte(`{"schema_version":1,"workflow":"vnext","reason":"work","graph_version":"g","plan_revision":1,"decision_authority":"core","kind":"done","next_stage":"ST-09"}`)
	if _, err := Decode(content); err == nil {
		t.Fatal("Decode() accepted next_stage")
	}
}

func TestDecodeRejectsNullOrEmptyForbiddenVariantFields(t *testing.T) {
	t.Parallel()
	for _, content := range [][]byte{
		[]byte(`{"schema_version":1,"kind":"done","workflow":"vnext","reason":"Complete.","graph_version":"g1","plan_revision":1,"decision_authority":"core","stage":null}`),
		[]byte(`{"schema_version":1,"kind":"done","workflow":"vnext","reason":"Complete.","graph_version":"g1","plan_revision":1,"decision_authority":"core","evidence":[]}`),
		[]byte(`{"schema_version":1,"kind":"approval","workflow":"vnext","reason":"Review.","graph_version":"g1","plan_revision":1,"decision_authority":"core","stage":"ST-05","candidate":{"artifact":"candidate","version":1,"source_of_truth":"a.json","sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"review":{"artifact":"review","version":1,"source_of_truth":"b.json","sha256":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"decisions":["approve","revise"],"feedback_reasons":[]}`),
	} {
		if _, err := Decode(content); err == nil {
			t.Fatalf("Decode() accepted forbidden variant field: %s", content)
		}
	}
}
