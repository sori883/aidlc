package jsonx

import "testing"

type fixture struct {
	Name string `json:"name"`
}

func TestDecodeRejectsUnknownAndTrailingJSON(t *testing.T) {
	t.Parallel()

	if _, err := Decode[fixture]([]byte(`{"name":"ok","extra":true}`)); err == nil {
		t.Fatal("Decode() accepted an unknown field")
	}
	if _, err := Decode[fixture]([]byte(`{"name":"ok"} {"name":"again"}`)); err == nil {
		t.Fatal("Decode() accepted trailing JSON")
	}
	got, err := Decode[fixture]([]byte(`{"name":"ok"}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if got.Name != "ok" {
		t.Fatalf("Decode() name = %q, want ok", got.Name)
	}
}
