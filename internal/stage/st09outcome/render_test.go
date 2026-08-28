package st09outcome

import (
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/gate"
)

func TestRenderHTMLExplainsOutcomeEvidence(t *testing.T) {
	content, err := renderHTML(Evaluation{
		EvaluationID:       "evaluation-1",
		IntentID:           "intent-1",
		OverallResult:      "achieved",
		ReleaseOutcome:     "released",
		Reason:             "すべて達成したため",
		OutcomeEvidenceRef: contract.ArtifactReference{SHA256: "sha256:evidence"},
		SignalResults:      []Observation{{SignalID: "SIG-001", Result: "achieved", Reason: "確認済み"}},
	}, gate.RequirementSet{})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"目的を達成できたか確認", "全体結果", "Signalごとの結果", "SIG-001", `meta name="viewport"`} {
		if !strings.Contains(content, marker) {
			t.Errorf("outcome HTML is missing %q", marker)
		}
	}
}
