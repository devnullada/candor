// Package native is Go written for Candor, bound in ../strings.candor.
package native

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Title upper-cases the first letter of every space-separated word.
func Title(s string) string {
	words := strings.Split(s, " ")
	for i, w := range words {
		r, n := utf8.DecodeRuneInString(w)
		if n > 0 {
			words[i] = string(unicode.ToUpper(r)) + w[n:]
		}
	}
	return strings.Join(words, " ")
}
