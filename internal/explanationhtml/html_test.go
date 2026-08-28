package explanationhtml

import (
	"strings"
	"testing"
)

func TestRenderProducesOneEscapedResponsiveDocument(t *testing.T) {
	content, err := Render(Page{
		Title:   "Review <unsafe>",
		Eyebrow: "ST-07",
		Heading: "確認 & 判断",
		Lead:    "<script>alert(1)</script>",
		Notice:  "初めて見る人向けです。",
		Metrics: []Metric{{Label: "結果", Value: "achieved", Tone: "success"}},
		Sections: []Section{{
			Heading: "詳細",
			Cards: []Card{{
				Heading: "候補",
				Facts:   []Fact{{Label: "SHA-256", Value: "sha256:<value>", Code: true}},
			}},
			Details: []Detail{{Summary: "技術情報", Facts: []Fact{{Label: "JSON", Value: "{\"x\":\"<tag>\"}", Pre: true}}}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{
		"<!doctype html>",
		`<html lang="ja">`,
		`<meta name="viewport"`,
		"@media(max-width:680px)",
		"@media print",
		"<details>",
		"&lt;script&gt;alert(1)&lt;/script&gt;",
		"sha256:&lt;value&gt;",
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("rendered HTML is missing %q", marker)
		}
	}
	if strings.Contains(content, "<script>") {
		t.Fatal("rendered HTML contains unescaped script")
	}
	for _, marker := range []string{"<!doctype html>", "<html ", "<body>", "<main>"} {
		if count := strings.Count(content, marker); count != 1 {
			t.Errorf("%q count = %d, want 1", marker, count)
		}
	}
}

func TestRenderRequiresTitleAndHeading(t *testing.T) {
	if _, err := Render(Page{Heading: "heading"}); err == nil {
		t.Fatal("Render() accepted a missing title")
	}
	if _, err := Render(Page{Title: "title"}); err == nil {
		t.Fatal("Render() accepted a missing heading")
	}
}
