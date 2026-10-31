// Package regexgo is the Go under std/regex.candor: Go's regexp (RE2 syntax, linear time). A
// Regex crosses as its pattern; the compiled one is kept here by pattern. Matches cross as
// JSON, with positions in code points, as Candor's strings count them.
package regexgo

import (
	"encoding/json"
	"regexp"
	"sync"
	"unicode/utf8"
)

var (
	mu       sync.Mutex
	compiled = map[string]*regexp.Regexp{}
)

// get compiles pattern once. A pattern reaching it passed Check, so it compiles.
func get(pattern string) *regexp.Regexp {
	mu.Lock()
	defer mu.Unlock()
	if re, ok := compiled[pattern]; ok {
		return re
	}
	if len(compiled) >= 1000 {
		// Patterns made from data could grow this without end; start over instead.
		compiled = map[string]*regexp.Regexp{}
	}
	re := regexp.MustCompile(pattern)
	compiled[pattern] = re
	return re
}

// Check is nil when pattern compiles, else Go's syntax error.
func Check(pattern string) error {
	_, err := regexp.Compile(pattern)
	return err
}

type match struct {
	Text   string            `json:"text"`
	Start  int               `json:"start"`
	End    int               `json:"end"`
	Groups []string          `json:"groups"`
	Named  map[string]string `json:"named"`
}

// Find gives up to n matches of pattern in s (n < 0: all), as a JSON list.
func Find(pattern, s string, n int) string {
	re := get(pattern)
	names := re.SubexpNames()
	// Byte offsets to code points, counted as the matches move along s.
	at, cp := 0, 0
	points := func(b int) int {
		cp += utf8.RuneCountInString(s[at:b])
		at = b
		return cp
	}
	out := []match{}
	for _, loc := range re.FindAllStringSubmatchIndex(s, n) {
		m := match{Text: s[loc[0]:loc[1]], Start: points(loc[0]), Named: map[string]string{}}
		for g := 0; g < len(loc)/2; g++ {
			if loc[2*g] < 0 {
				m.Groups = append(m.Groups, "")
				continue
			}
			text := s[loc[2*g]:loc[2*g+1]]
			m.Groups = append(m.Groups, text)
			if names[g] != "" {
				m.Named[names[g]] = text
			}
		}
		m.End = m.Start + utf8.RuneCountInString(m.Text)
		out = append(out, m)
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// Replace replaces every match of pattern in s with with, `$1` and `${name}` expanded.
func Replace(pattern, s, with string) string {
	return get(pattern).ReplaceAllString(s, with)
}

// Split cuts s around the matches of pattern.
func Split(pattern, s string) []string {
	return get(pattern).Split(s, -1)
}

// Quote escapes every metacharacter in s, for a pattern matching s itself.
func Quote(s string) string {
	return regexp.QuoteMeta(s)
}
