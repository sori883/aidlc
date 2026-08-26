package stage2poc

import "testing"

func TestExecutableFormat(t *testing.T) {
	t.Parallel()
	tests := map[string][]byte{
		"elf":    {0x7f, 'E', 'L', 'F'},
		"pe":     {'M', 'Z', 0, 0},
		"mach-o": {0xcf, 0xfa, 0xed, 0xfe},
	}
	for want, content := range tests {
		want, content := want, content
		t.Run(want, func(t *testing.T) {
			t.Parallel()
			got, err := executableFormat(content)
			if err != nil || got != want {
				t.Fatalf("executableFormat() = %q, %v; want %q", got, err, want)
			}
		})
	}
}

func TestTargetMatrix(t *testing.T) {
	t.Parallel()
	if got, want := len(Targets), 5; got != want {
		t.Fatalf("len(Targets) = %d, want %d", got, want)
	}
	seen := make(map[string]bool)
	for _, target := range Targets {
		if seen[target.Name] {
			t.Fatalf("duplicate target: %s", target.Name)
		}
		seen[target.Name] = true
		if target.Name == "linux-amd64" && target.GOAMD64 != "v1" {
			t.Fatalf("linux-amd64 GOAMD64 = %q, want v1", target.GOAMD64)
		}
	}
}

func TestPathWithin(t *testing.T) {
	t.Parallel()
	if !pathWithin("/repo", "/repo/build/stage2") {
		t.Fatal("expected build path to be accepted")
	}
	if pathWithin("/repo", "/outside") {
		t.Fatal("expected outside path to be rejected")
	}
}
