package st05buildcontract

import (
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/gate"
)

func TestRenderReviewProducesOneExplanatoryDocument(t *testing.T) {
	content, err := renderReview(Candidate{
		ProposalID: "proposal-1",
		IntentID:   "intent-1",
		Reason:     "変更理由 <unsafe>",
		ChangeContracts: []ChangeContract{{
			ContractID: "CHG-001",
			Title:      "変更内容",
			Targets:    []Target{{SourceID: "repo-1", Path: "index.html"}},
		}},
	}, contract.ArtifactReference{SHA256: "sha256:candidate"}, gate.RequirementSet{})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"実装前の約束を確認", "まず確認すること", "Candidate SHA-256", "&lt;unsafe&gt;", `meta name="viewport"`} {
		if !strings.Contains(content, marker) {
			t.Errorf("review HTML is missing %q", marker)
		}
	}
	if count := strings.Count(content, "<!doctype html>"); count != 1 {
		t.Fatalf("doctype count = %d, want 1", count)
	}
}
