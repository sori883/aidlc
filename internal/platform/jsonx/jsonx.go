package jsonx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Decode rejects unknown fields and trailing JSON.
func Decode[T any](data []byte) (T, error) {
	var value T
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return value, fmt.Errorf("trailing JSON value is not allowed")
		}
		return value, fmt.Errorf("trailing JSON is invalid: %w", err)
	}
	return value, nil
}

// ReadFile decodes one strict JSON value from path.
func ReadFile[T any](path string) (T, error) {
	var zero T
	data, err := os.ReadFile(path)
	if err != nil {
		return zero, err
	}
	value, err := Decode[T](data)
	if err != nil {
		return zero, fmt.Errorf("decode %s: %w", path, err)
	}
	return value, nil
}

// MarshalCanonical emits stable two-space-indented JSON with a trailing newline.
// Struct field order is declaration order; maps are sorted by encoding/json.
func MarshalCanonical(value any) ([]byte, error) {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode canonical JSON: %w", err)
	}
	content = append(content, '\n')
	if !json.Valid(bytes.TrimSpace(content)) {
		return nil, fmt.Errorf("encoded canonical JSON is invalid")
	}
	return content, nil
}
