package st08release

import (
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/gate"
)

func TestRenderHTMLExplainsReleaseAuthority(t *testing.T) {
	content, err := renderHTML(Plan{
		IntentID:             "intent-1",
		Reason:               "mainへ反映するため",
		AcceptedCandidateRef: contract.ArtifactReference{SHA256: "sha256:candidate"},
		ReviewCurrentRef:     contract.ArtifactReference{SHA256: "sha256:review"},
		Targets:              []Target{{ProposedTarget: ProposedTarget{TargetID: "target-1", TargetKind: "git", Provider: "git", Locator: "origin/main"}}},
	}, gate.RequirementSet{})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"Release前の最終確認", "外部の対象へ変更を反映する許可", "Releaseする対象", "origin/main", `meta name="viewport"`} {
		if !strings.Contains(content, marker) {
			t.Errorf("release HTML is missing %q", marker)
		}
	}
}
