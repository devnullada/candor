package candor

import (
	"fmt"
	"strings"
)

// LoadEnv reads a .env file into env: `KEY=value` lines, each set unless the variable is set
// already, so the real environment wins. Candor: `env.load(path)`.
func (f *FS) LoadEnv(c *Ctx, env Env, p string) *FsErr {
	text, e := f.Read(c, p)
	if e != nil {
		return e
	}
	pairs, err := ParseDotenv(text)
	if err != nil {
		return &FsErr{Kind: 2, Path: p, Message: err.Error()}
	}
	for _, kv := range pairs {
		env.SetDefault(c, kv[0], kv[1])
	}
	return nil
}

// ParseDotenv reads `KEY=value` lines, in order; a later line for the same key wins. Blank
// lines and `#` comments are skipped, and `export ` before a key is allowed. A value in double
// quotes takes `\n`, `\t`, `\"` and `\\`; in single quotes it is as written; bare, it is trimmed
// and ends at ` #`. No values over several lines, no `${VAR}`.
func ParseDotenv(text string) ([][2]string, error) {
	var pairs [][2]string
	at := map[string]int{}
	for n, line := range Lines(text) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("line %d: expected KEY=value", n+1)
		}
		key := strings.TrimSpace(line[:eq])
		if !envKey(key) {
			return nil, fmt.Errorf("line %d: %q is not a variable name (letters, digits and _, not starting with a digit)", n+1, key)
		}
		value, err := dotenvValue(strings.TrimSpace(line[eq+1:]))
		if err != nil {
			return nil, fmt.Errorf("line %d: %s", n+1, err)
		}
		if i, ok := at[key]; ok {
			pairs[i][1] = value
			continue
		}
		at[key] = len(pairs)
		pairs = append(pairs, [2]string{key, value})
	}
	return pairs, nil
}

func envKey(k string) bool {
	if k == "" || (k[0] >= '0' && k[0] <= '9') {
		return false
	}
	for _, r := range k {
		if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func dotenvValue(v string) (string, error) {
	if v == "" {
		return "", nil
	}
	switch v[0] {
	case '\'':
		end := strings.IndexByte(v[1:], '\'')
		if end < 0 {
			return "", fmt.Errorf("no closing '")
		}
		return v[1 : end+1], dotenvRest(v[end+2:])
	case '"':
		var b strings.Builder
		for i := 1; i < len(v); i++ {
			switch ch := v[i]; ch {
			case '"':
				return b.String(), dotenvRest(v[i+1:])
			case '\\':
				if i+1 == len(v) {
					return "", fmt.Errorf("no closing \"")
				}
				i++
				switch v[i] {
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				case 'r':
					b.WriteByte('\r')
				default:
					b.WriteByte(v[i])
				}
			default:
				b.WriteByte(ch)
			}
		}
		return "", fmt.Errorf("no closing \"")
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v), nil
}

// After a quoted value: nothing, or a comment.
func dotenvRest(rest string) error {
	rest = strings.TrimSpace(rest)
	if rest == "" || strings.HasPrefix(rest, "#") {
		return nil
	}
	return fmt.Errorf("unexpected %q after the closing quote", rest)
}
