package candor

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// `flags.parse`, read as Go's flag package reads a command line: `-x` or `--x`,
// `-x=value`, `-x value` for a flag that takes one (never for a bool), up to the first argument
// that isn't a flag or `--`. The compiler gives a Flag for each field of the options struct; its
// Set writes the field.

// Flag is one field of the options struct.
type Flag struct {
	Name string
	// "string", "int", "float", "bool" or "duration"; a list's or an optional's is its item's.
	Kind string
	Help string
	// The default, as the field holds it before parsing: shown in the usage unless it is zero.
	// A duration's is its milliseconds; an optional's, nil.
	Default any
	// Set reads one value into the field: "" if it was read, Go's reason if not.
	Set func(text string) string
}

// ParseFlags gives the arguments after the flags, or, when they stop the program, the status
// and message for an Exit: 2 and the mistake with the usage, or 0 and the usage for -h or -help
// when the struct has no such field. status is -1 when they don't.
func ParseFlags(args []string, header string, flags []Flag) (rest []string, status int, message string) {
	byName := map[string]*Flag{}
	for i := range flags {
		byName[flags[i].Name] = &flags[i]
	}
	usage := FlagUsage(header, flags)
	fail := func(format string, a ...any) ([]string, int, string) {
		return nil, 2, fmt.Sprintf(format, a...) + "\n" + usage
	}
	for len(args) > 0 {
		s := args[0]
		if len(s) < 2 || s[0] != '-' {
			break
		}
		minuses := 1
		if s[1] == '-' {
			minuses++
			if len(s) == 2 {
				args = args[1:]
				break
			}
		}
		name := s[minuses:]
		if len(name) == 0 || name[0] == '-' || name[0] == '=' {
			return fail("bad flag syntax: %s", s)
		}
		args = args[1:]
		value, hasValue := "", false
		if i := strings.IndexByte(name[1:], '='); i >= 0 {
			name, value, hasValue = name[:i+1], name[i+2:], true
		}
		f := byName[name]
		if f == nil {
			if name == "help" || name == "h" {
				return nil, 0, usage
			}
			return fail("flag provided but not defined: -%s", name)
		}
		if f.Kind == "bool" {
			if !hasValue {
				value = "true"
			}
			if why := f.Set(value); why != "" {
				return fail("invalid boolean value %q for -%s: %s", value, name, why)
			}
			continue
		}
		if !hasValue && len(args) > 0 {
			value, args, hasValue = args[0], args[1:], true
		}
		if !hasValue {
			return fail("flag needs an argument: -%s", name)
		}
		if why := f.Set(value); why != "" {
			return fail("invalid value %q for flag -%s: %s", value, name, why)
		}
	}
	if args == nil {
		args = []string{}
	}
	return args, -1, ""
}

// FlagUsage is Go's PrintDefaults under the header: the flags in name order, each with its kind
// and help, and its default unless that is zero.
func FlagUsage(header string, flags []Flag) string {
	sorted := append([]Flag(nil), flags...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	var b strings.Builder
	b.WriteString(header)
	for _, f := range sorted {
		var line strings.Builder
		fmt.Fprintf(&line, "  -%s", f.Name)
		kind, help := unquoteUsage(f)
		if kind != "" {
			line.WriteString(" " + kind)
		}
		if line.Len() <= 4 {
			line.WriteString("\t")
		} else {
			line.WriteString("\n    \t")
		}
		line.WriteString(strings.ReplaceAll(help, "\n", "\n    \t"))
		if d := flagDefault(f); d != "" {
			line.WriteString(" (default " + d + ")")
		}
		b.WriteString("\n" + line.String())
	}
	return b.String()
}

// unquoteUsage is Go's: a name in backquotes in the help is the kind shown, `-o file` for
// "write to `file`". A bool shows none.
func unquoteUsage(f Flag) (string, string) {
	help := f.Help
	if i := strings.IndexByte(help, '`'); i >= 0 {
		if j := strings.IndexByte(help[i+1:], '`'); j >= 0 {
			name := help[i+1 : i+1+j]
			return name, help[:i] + name + help[i+2+j:]
		}
	}
	if f.Kind == "bool" {
		return "", help
	}
	return f.Kind, help
}

// flagDefault is the default as the usage shows it, "" when it is zero.
func flagDefault(f Flag) string {
	switch d := f.Default.(type) {
	case string:
		if d != "" {
			return strconv.Quote(d)
		}
	case int64:
		if f.Kind == "duration" {
			if d != 0 {
				return FormatDurationMs(d)
			}
		} else if d != 0 {
			return strconv.FormatInt(d, 10)
		}
	case float64:
		if d != 0 {
			return strconv.FormatFloat(d, 'g', -1, 64)
		}
	case bool:
		if d {
			return "true"
		}
	case []string:
		if len(d) > 0 {
			return fmt.Sprint(d)
		}
	case []int64:
		if len(d) > 0 {
			if f.Kind == "duration" {
				parts := make([]string, len(d))
				for i, ms := range d {
					parts[i] = FormatDurationMs(ms)
				}
				return fmt.Sprint(parts)
			}
			return fmt.Sprint(d)
		}
	case []float64:
		if len(d) > 0 {
			return fmt.Sprint(d)
		}
	}
	return ""
}

// FlagInt is Go's strconv.ParseInt(s, 0, 64), as the flag package reads an int: 0x, 0o, 0b and _.
func FlagInt(s string) (int64, string) {
	v, err := strconv.ParseInt(s, 0, 64)
	return v, numError(err)
}

func FlagFloat(s string) (float64, string) {
	v, err := strconv.ParseFloat(s, 64)
	return v, numError(err)
}

func FlagBool(s string) (bool, string) {
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, "parse error"
	}
	return v, ""
}

// FlagDuration is Go's time.ParseDuration in whole milliseconds; a part of one is dropped.
func FlagDuration(s string) (int64, string) {
	ms, ok := ParseDurationMs(s)
	if !ok {
		return 0, "parse error"
	}
	return ms, ""
}

func numError(err error) string {
	if err == nil {
		return ""
	}
	if e, ok := err.(*strconv.NumError); ok && e.Err == strconv.ErrRange {
		return "value out of range"
	}
	return "parse error"
}

// ParseDurationMs is Go's time.ParseDuration ("1m30s", "500ms", "-2h") in whole milliseconds.
func ParseDurationMs(s string) (int64, bool) {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, false
	}
	return d.Milliseconds(), true
}

// FormatDurationMs is Go's Duration.String: "1m30s", "500ms", "0s".
func FormatDurationMs(ms int64) string {
	return (time.Duration(ms) * time.Millisecond).String()
}
