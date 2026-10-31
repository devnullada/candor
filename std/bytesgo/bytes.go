// Package bytesgo is the Go under std/bytes.candor's charsets: x/text's encodings, found by the
// labels the WHATWG Encoding Standard gives them, as browsers find them.
package bytesgo

import (
	"golang.org/x/text/encoding/htmlindex"
)

// Decode reads data in charset as UTF-8; ok is false for a charset x/text doesn't know. Bytes
// the charset doesn't allow become U+FFFD.
func Decode(data string, charset string) (string, bool) {
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return "", false
	}
	out, err := enc.NewDecoder().String(data)
	if err != nil {
		return "", false
	}
	return out, true
}

// Encode writes s in charset; ok is false for a charset x/text doesn't know, or when s has a
// character the charset can't write.
func Encode(s string, charset string) (string, bool) {
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return "", false
	}
	out, err := enc.NewEncoder().String(s)
	if err != nil {
		return "", false
	}
	return out, true
}

// Name is charset's canonical name ("iso-8859-1" is "windows-1252"), or "" for one x/text
// doesn't know.
func Name(charset string) string {
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return ""
	}
	name, err := htmlindex.Name(enc)
	if err != nil {
		return ""
	}
	return name
}
