package candor

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseDotenv(t *testing.T) {
	text := strings.Join([]string{
		"# a comment",
		"",
		"PORT=8080",
		"export NAME = my app # trailing",
		`QUOTED="a\nb \"c\" # kept"`,
		`SINGLE='raw \n # kept'`,
		"EMPTY=",
		"URL=http://x/#frag",
		"PORT=9090",
		"\r",
	}, "\r\n")
	got, err := ParseDotenv(text)
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]string{
		{"PORT", "9090"},
		{"NAME", "my app"},
		{"QUOTED", "a\nb \"c\" # kept"},
		{"SINGLE", `raw \n # kept`},
		{"EMPTY", ""},
		{"URL", "http://x/#frag"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseDotenv = %q", got)
	}
}

func TestParseDotenvErrors(t *testing.T) {
	for text, want := range map[string]string{
		"A=1\nnope":    "line 2: expected KEY=value",
		"1A=x":         `line 1: "1A" is not a variable name`,
		"MY-KEY=x":     `line 1: "MY-KEY" is not a variable name`,
		`A="open`:      `line 1: no closing "`,
		"A='open":      "line 1: no closing '",
		`A="x" y`:      `line 1: unexpected "y" after the closing quote`,
		`A="ends in \`: `line 1: no closing "`,
	} {
		_, err := ParseDotenv(text)
		if err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Errorf("ParseDotenv(%q) = %v, want %s", text, err, want)
		}
	}
}
