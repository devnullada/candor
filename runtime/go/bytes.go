package candor

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Bytes are a []byte that is never changed once made, like a string: what makes one makes a
// fresh slice, and what cuts one keeps its capacity to its length, so `concat` can't write into
// another's bytes. A byte is an int64 from 0 to 255.

// ByteAt is b[i], and whether i is in range.
func ByteAt(b []byte, i int64) (int64, bool) {
	if i < 0 || i >= int64(len(b)) {
		return 0, false
	}
	return int64(b[i]), true
}

// SliceBytes is the bytes from start up to end, both clamped to b like a string's `slice`.
func SliceBytes(b []byte, start, end int64) []byte {
	n := int64(len(b))
	start = min(max(start, 0), n)
	end = min(max(end, start), n)
	return b[start:end:end]
}

// ConcatBytes is a then b, in a fresh slice.
func ConcatBytes(a, b []byte) []byte {
	out := make([]byte, 0, len(a)+len(b))
	return append(append(out, a...), b...)
}

// IndexBytes is where sub first occurs in b, and whether it occurs at all.
func IndexBytes(b, sub []byte) (int64, bool) {
	i := bytes.Index(b, sub)
	return int64(i), i >= 0
}

// LastIndexBytes is where sub last occurs in b, and whether it occurs at all.
func LastIndexBytes(b, sub []byte) (int64, bool) {
	i := bytes.LastIndex(b, sub)
	return int64(i), i >= 0
}

// BytesEqual is `==` on Bytes; nil and empty are the same.
func BytesEqual(a, b []byte) bool { return bytes.Equal(a, b) }

// BytesToList is `b.toList()`: each byte as an int.
func BytesToList(b []byte) []int64 {
	out := make([]int64, len(b))
	for i, x := range b {
		out[i] = int64(x)
	}
	return out
}

// BytesFromList is `bytes.fromList(xs)`; a number outside 0 to 255 panics.
func BytesFromList(xs []int64) []byte {
	out := make([]byte, len(xs))
	for i, x := range xs {
		if x < 0 || x > 255 {
			panic(fmt.Sprintf("bytes.fromList: %d at index %d is not a byte (0 to 255)", x, i))
		}
		out[i] = byte(x)
	}
	return out
}

// BytesText is the bytes as a string, if they are UTF-8.
func BytesText(b []byte) (string, bool) {
	if !utf8.Valid(b) {
		return "", false
	}
	return string(b), true
}

// BytesHex is lowercase hex, two digits a byte.
func BytesHex(b []byte) string { return hex.EncodeToString(b) }

// BytesFromHex reads hex in either case, two digits a byte; anything else is none.
func BytesFromHex(s string) ([]byte, bool) {
	b, err := hex.DecodeString(s)
	return b, err == nil
}

// BytesBase64 is standard base64 (RFC 4648), padded: what JSON holds.
func BytesBase64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// BytesFromBase64 reads standard base64, padded or not, or its URL form (`-` and `_`).
func BytesFromBase64(s string) ([]byte, bool) {
	s = strings.TrimRight(s, "=")
	enc := base64.RawStdEncoding
	if strings.ContainsAny(s, "-_") {
		enc = base64.RawURLEncoding
	}
	b, err := enc.DecodeString(s)
	return b, err == nil
}
