package st07review

import (
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/gate"
)

func TestRenderHTMLExplainsTheHumanDecision(t *testing.T) {
	content, err := renderHTML(Manifest{
		IntentID:             "intent-1",
		RunnableCandidateRef: contract.ArtifactReference{SHA256: "sha256:candidate"},
		BuildContractRef:     contract.ArtifactReference{SHA256: "sha256:contract"},
		Requirements:         []RequirementSummary{{RequirementID: "REQ-F-001", Statement: "表示できること"}},
		HumanChecks:          []HumanCheck{{VerifierID: "VER-001", Expected: "完成物を確認する"}},
	}, gate.RequirementSet{})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"完成したものを確認", "このページで決めること", "人が実物を見て確認すること", "REQ-F-001", `meta name="viewport"`} {
		if !strings.Contains(content, marker) {
			t.Errorf("review HTML is missing %q", marker)
		}
	}
}
