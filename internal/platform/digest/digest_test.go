package digest

import (
	"strings"
	"testing"
)

func TestBytesAndValidate(t *testing.T) {
	t.Parallel()
	got := Bytes([]byte("abc"))
	want := "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Fatalf("Bytes() = %q, want %q", got, want)
	}
	if err := Validate(got); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{strings.TrimPrefix(got, "sha256:"), strings.ToUpper(got), "sha256:abc"} {
		if Validate(invalid) == nil {
			t.Fatalf("Validate(%q) succeeded", invalid)
		}
	}
}
