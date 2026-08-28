// Package explanationhtml renders self-contained, beginner-friendly HTML
// explanations from typed Core data.
package explanationhtml

import (
	"fmt"
	"html/template"
	"strings"
)

// Page is one complete explanatory HTML document.
type Page struct {
	Lang     string
	Title    string
	Eyebrow  string
	Heading  string
	Lead     string
	Notice   string
	Metrics  []Metric
	Sections []Section
	Footer   []Fact
}

// Metric surfaces one high-level fact before the detailed sections.
type Metric struct {
	Label string
	Value string
	Help  string
	Tone  string
}

// Section groups one human-readable idea.
type Section struct {
	Heading string
	Lead    string
	Ordered bool
	Items   []Item
	Cards   []Card
	Details []Detail
}

// Card presents one decision, change, check, or result.
type Card struct {
	Label   string
	Heading string
	Text    string
	Tone    string
	Facts   []Fact
	Items   []Item
}

// Fact is a label and value pair. Code and Pre change only presentation; the
// template still escapes the value.
type Fact struct {
	Label string
	Value string
	Code  bool
	Pre   bool
}

// Item is one semantic list entry.
type Item struct {
	Label string
	Text  string
}

// Detail keeps technical information available without placing it before the
// human decision.
type Detail struct {
	Summary string
	Text    string
	Facts   []Fact
	Items   []Item
}

var documentTemplate = template.Must(template.New("explanation").Parse(pageTemplate))

// Render validates and renders a self-contained HTML document. All caller data
// is escaped by html/template.
func Render(page Page) (string, error) {
	if strings.TrimSpace(page.Title) == "" {
		return "", fmt.Errorf("explanation HTML title is required")
	}
	if strings.TrimSpace(page.Heading) == "" {
		return "", fmt.Errorf("explanation HTML heading is required")
	}
	if strings.TrimSpace(page.Lang) == "" {
		page.Lang = "ja"
	}
	var output strings.Builder
	if err := documentTemplate.Execute(&output, page); err != nil {
		return "", err
	}
	return output.String(), nil
}

const pageTemplate = `<!doctype html>
<html lang="{{.Lang}}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{.Title}}</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#59677d;--line:#d8e0eb;--paper:#fff;--wash:#f3f6fa;--primary:#2457a6;--primary-soft:#eaf1fc;--success:#17643a;--success-soft:#eaf7ef;--warning:#8a3d08;--warning-soft:#fff1e6;--shadow:0 14px 38px rgba(23,32,51,.09)}
    *{box-sizing:border-box}
    html{background:var(--wash)}
    body{margin:0;color:var(--ink);background:radial-gradient(circle at top right,#dbe8fb 0,transparent 32rem),var(--wash);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7}
    main{width:min(940px,calc(100% - 32px));margin:32px auto;min-width:0}
    header,section,footer{min-width:0;background:var(--paper);border:1px solid rgba(216,224,235,.92);border-radius:18px;box-shadow:var(--shadow)}
    header{padding:clamp(24px,5vw,46px)}
    section,footer{margin-top:18px;padding:clamp(21px,4vw,32px)}
    h1,h2,h3,p,li,dt,dd,code,pre{overflow-wrap:anywhere}
    h1{margin:8px 0 13px;font-size:clamp(2rem,7vw,3.2rem);line-height:1.16;letter-spacing:-.035em}
    h2{margin:0 0 11px;font-size:clamp(1.35rem,4vw,1.75rem);line-height:1.3}
    h3{margin:0 0 6px;font-size:1.08rem;line-height:1.4}
    p{margin:.55rem 0}
    ul,ol{margin:.8rem 0;padding-left:1.35rem}
    li+li{margin-top:.55rem}
    code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
    code{max-width:100%;padding:.14em .38em;border-radius:.34em;background:#edf1f6}
    pre{max-width:100%;margin:.5rem 0;padding:13px;border-radius:10px;background:#172033;color:#f5f7fb;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto}
    .eyebrow{margin:0;color:var(--primary);font-size:.84rem;font-weight:800;letter-spacing:.05em}
    .lead{max-width:68ch;color:var(--muted);font-size:1.07rem}
    .notice{margin-top:20px;padding:16px 18px;border-left:5px solid var(--primary);border-radius:11px;background:var(--primary-soft)}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:11px;margin-top:20px}
    .metric{min-width:0;padding:15px;border:1px solid var(--line);border-radius:12px;background:#fbfcfe}
    .metric.success{border-color:#bfddca;background:var(--success-soft)}
    .metric.warning{border-color:#efc7a8;background:var(--warning-soft)}
    .metric-label,.metric-value,.metric-help{display:block}
    .metric-label{color:var(--muted);font-size:.82rem;font-weight:700}
    .metric-value{margin-top:3px;font-size:1.18rem;font-weight:800}
    .metric-help{margin-top:2px;color:var(--muted);font-size:.83rem}
    .section-lead{max-width:70ch;color:var(--muted)}
    .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:15px}
    .card{min-width:0;padding:17px;border:1px solid var(--line);border-radius:13px;background:#fbfcfe}
    .card.success{border-color:#bfddca;background:var(--success-soft)}
    .card.warning{border-color:#efc7a8;background:var(--warning-soft)}
    .card-label{display:block;margin-bottom:7px;color:var(--primary);font-size:.8rem;font-weight:800;letter-spacing:.04em}
    dl{display:grid;grid-template-columns:minmax(110px,.38fr) minmax(0,1fr);gap:8px 12px;margin:13px 0 0;padding-top:12px;border-top:1px solid var(--line)}
    dt{color:var(--muted);font-size:.86rem;font-weight:700}
    dd{min-width:0;margin:0}
    details{margin-top:13px;border:1px solid var(--line);border-radius:11px;background:#fff}
    summary{padding:12px 14px;cursor:pointer;font-weight:750}
    summary:focus-visible{outline:3px solid #86abe4;outline-offset:3px}
    .detail-body{padding:0 14px 13px}
    footer{color:var(--muted);font-size:.88rem}
    footer dl{margin:0;padding:0;border:0}
    @media(max-width:680px){main{width:min(100% - 20px,940px);margin:10px auto 22px}header,section,footer{border-radius:13px}.cards{grid-template-columns:1fr}dl{grid-template-columns:1fr;gap:2px}dd+dt{margin-top:8px}}
    @media print{body{background:#fff}main{width:100%;margin:0}header,section,footer{box-shadow:none;break-inside:avoid}details{break-inside:avoid}}
  </style>
</head>
<body>
  <main>
    <header>
      {{if .Eyebrow}}<p class="eyebrow">{{.Eyebrow}}</p>{{end}}
      <h1>{{.Heading}}</h1>
      {{if .Lead}}<p class="lead">{{.Lead}}</p>{{end}}
      {{if .Notice}}<div class="notice">{{.Notice}}</div>{{end}}
      {{if .Metrics}}<div class="metrics" aria-label="このページの要点">{{range .Metrics}}
        <div class="metric {{.Tone}}">
          <span class="metric-label">{{.Label}}</span>
          <span class="metric-value">{{.Value}}</span>
          {{if .Help}}<span class="metric-help">{{.Help}}</span>{{end}}
        </div>{{end}}
      </div>{{end}}
    </header>
    {{range .Sections}}
    <section>
      <h2>{{.Heading}}</h2>
      {{if .Lead}}<p class="section-lead">{{.Lead}}</p>{{end}}
      {{if .Items}}{{if .Ordered}}<ol>{{range .Items}}<li>{{if .Label}}<strong>{{.Label}}</strong> {{end}}{{.Text}}</li>{{end}}</ol>{{else}}<ul>{{range .Items}}<li>{{if .Label}}<strong>{{.Label}}</strong> {{end}}{{.Text}}</li>{{end}}</ul>{{end}}{{end}}
      {{if .Cards}}<div class="cards">{{range .Cards}}
        <article class="card {{.Tone}}">
          {{if .Label}}<span class="card-label">{{.Label}}</span>{{end}}
          {{if .Heading}}<h3>{{.Heading}}</h3>{{end}}
          {{if .Text}}<p>{{.Text}}</p>{{end}}
          {{if .Facts}}<dl>{{range .Facts}}<dt>{{.Label}}</dt><dd>{{if .Pre}}<pre>{{.Value}}</pre>{{else if .Code}}<code>{{.Value}}</code>{{else}}{{.Value}}{{end}}</dd>{{end}}</dl>{{end}}
          {{if .Items}}<ul>{{range .Items}}<li>{{if .Label}}<strong>{{.Label}}</strong> {{end}}{{.Text}}</li>{{end}}</ul>{{end}}
        </article>{{end}}
      </div>{{end}}
      {{range .Details}}<details>
        <summary>{{.Summary}}</summary>
        <div class="detail-body">
          {{if .Text}}<p>{{.Text}}</p>{{end}}
          {{if .Facts}}<dl>{{range .Facts}}<dt>{{.Label}}</dt><dd>{{if .Pre}}<pre>{{.Value}}</pre>{{else if .Code}}<code>{{.Value}}</code>{{else}}{{.Value}}{{end}}</dd>{{end}}</dl>{{end}}
          {{if .Items}}<ul>{{range .Items}}<li>{{if .Label}}<strong>{{.Label}}</strong> {{end}}{{.Text}}</li>{{end}}</ul>{{end}}
        </div>
      </details>{{end}}
    </section>{{end}}
    {{if .Footer}}<footer aria-label="正本情報"><dl>{{range .Footer}}<dt>{{.Label}}</dt><dd>{{if .Pre}}<pre>{{.Value}}</pre>{{else if .Code}}<code>{{.Value}}</code>{{else}}{{.Value}}{{end}}</dd>{{end}}</dl></footer>{{end}}
  </main>
</body>
</html>
`
