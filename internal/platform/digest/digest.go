// Package digest implements canonical SHA-256 identifiers used by AI-DLC.
package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
)

var canonicalPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

// Bytes returns a canonical sha256:<lowercase-hex> identifier.
func Bytes(content []byte) string {
	sum := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Reader hashes all raw bytes from reader.
func Reader(reader io.Reader) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, reader); err != nil {
		return "", fmt.Errorf("read SHA-256 input: %w", err)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

// File hashes a file's raw bytes without parsing or reserializing it.
func File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open SHA-256 input %s: %w", path, err)
	}
	defer file.Close()
	return Reader(file)
}

// Validate rejects non-canonical digest spellings.
func Validate(value string) error {
	if !canonicalPattern.MatchString(value) {
		return fmt.Errorf("must use sha256:<64 lowercase hex characters>")
	}
	return nil
}
