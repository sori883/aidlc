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

func TestMarshalCanonical(t *testing.T) {
	t.Parallel()
	content, err := MarshalCanonical(struct {
		Schema int    `json:"schema"`
		Name   string `json:"name"`
	}{Schema: 1, Name: "aidlc"})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"schema\": 1,\n  \"name\": \"aidlc\"\n}\n"
	if got := string(content); got != want {
		t.Fatalf("MarshalCanonical() = %q, want %q", got, want)
	}
}
