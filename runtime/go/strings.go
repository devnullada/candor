package candor

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Strings are UTF-8, as in Go. Where Go counts bytes, Candor counts code points: `length`,
// `indexOf` and `slice` come here; `chars()` is Go's []rune. An invalid byte counts as one code
// point, as utf8.RuneCountInString counts it, and is U+FFFD as a char.

// ToChar is the char with code point n, if n is one (not a surrogate, not past U+10FFFF).
func ToChar(n int64) (rune, bool) {
	if n < 0 || n > utf8.MaxRune || !utf8.ValidRune(rune(n)) {
		return 0, false
	}
	return rune(n), true
}

// JoinChars is `cs.join(sep)` on a List<char>.
func JoinChars(cs []rune, sep string) string {
	if sep == "" {
		return string(cs)
	}
	parts := make([]string, len(cs))
	for i, c := range cs {
		parts[i] = string(c)
	}
	return strings.Join(parts, sep)
}

// IsDigit is ASCII 0-9 only: what `toInt` reads.
func IsDigit(c rune) bool { return '0' <= c && c <= '9' }

// IndexOf is where sub first occurs in s, in code points, and whether it occurs at all.
func IndexOf(s, sub string) (int64, bool) {
	i := strings.Index(s, sub)
	if i < 0 {
		return 0, false
	}
	return int64(utf8.RuneCountInString(s[:i])), true
}

// LastIndexOf is where sub last occurs in s, in code points, and whether it occurs at all.
func LastIndexOf(s, sub string) (int64, bool) {
	i := strings.LastIndex(s, sub)
	if i < 0 {
		return 0, false
	}
	return int64(utf8.RuneCountInString(s[:i])), true
}

// Slice is the code points of s from start up to end. Both clamp to the string, a negative
// one to 0, so `s.slice(0, 80)` shortens any string and `s.slice(n - 3, n)` is at most the
// last three.
func Slice(s string, start, end int64) string {
	start = max(start, 0)
	if end <= start {
		return ""
	}
	a := byteOffset(s, start)
	return s[a : a+byteOffset(s[a:], end-start)]
}

// byteOffset is where the k-th code point of s starts, or len(s) when s has fewer.
func byteOffset(s string, k int64) int {
	i := 0
	for ; k > 0 && i < len(s); k-- {
		_, w := utf8.DecodeRuneInString(s[i:])
		i += w
	}
	return i
}

// Repeat is s written n times.
func Repeat(s string, n int64) string {
	if n < 0 {
		panic(fmt.Sprintf("repeat(%d): the count cannot be negative", n))
	}
	return strings.Repeat(s, int(n))
}

// Lines splits s at "\n" and "\r\n". A final line break ends the last line rather than
// starting an empty one, so "a\nb\n" is two lines and "" is none.
func Lines(s string) []string {
	out := []string{}
	for s != "" {
		i := strings.IndexByte(s, '\n')
		line := s
		if i < 0 {
			s = ""
		} else {
			line, s = s[:i], s[i+1:]
		}
		out = append(out, strings.TrimSuffix(line, "\r"))
	}
	return out
}

// PadStart puts copies of fill before s until it is n code points long; the last copy is cut
// short to fit. A string already that long, or an empty fill, is left as it is.
func PadStart(s string, n int64, fill string) string {
	return padding(s, n, fill) + s
}

// PadEnd is PadStart with the fill after s.
func PadEnd(s string, n int64, fill string) string {
	return s + padding(s, n, fill)
}

func padding(s string, n int64, fill string) string {
	need := n - int64(utf8.RuneCountInString(s))
	if need <= 0 || fill == "" {
		return ""
	}
	per := int64(utf8.RuneCountInString(fill))
	out := strings.Repeat(fill, int(need/per))
	return out + fill[:byteOffset(fill, need%per)]
}

// ParseInt reads a decimal int with an optional sign: "42", "-7". Anything else is not an int,
// out of range included.
func ParseInt(s string) (int64, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		// strconv hands back the nearest int on a range error; none has no value.
		return 0, false
	}
	return n, true
}
