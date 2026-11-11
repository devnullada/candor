// Package native is Go written for Candor, bound in ../hashing.candor: bytes don't cross a
// binding, so the hashing and encoding are done here on a string's UTF-8 bytes.
package native

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// Sha256Hex is the SHA-256 of s's bytes, as 64 lowercase hex digits.
func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Base64 is s's bytes in standard base64, with padding.
func Base64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}
