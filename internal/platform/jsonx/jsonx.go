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
