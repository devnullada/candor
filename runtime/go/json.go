package candor

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Json is a dictionary writing and reading values of T as JSON: `impl Json`, derived. The
// generated ones are in the program; int, string, bool, lists and maps are here.
type Json[T any] interface {
	Enc(o *JsonOut, v T)
	// Dec reads a value parsed by JsonParse; path names it in errors.
	Dec(in *JsonIn, j any, path string) (T, *JsonErr)
}

// JsonIn is how a document is being read: the context `fromJson` runs in, and whether an
// unknown field is an error (`json.decodeStrict`).
type JsonIn struct {
	Ctx    *Ctx
	Strict bool
}

// JsonErr is why a value didn't decode, and where: `$.items[2].title`.
type JsonErr struct {
	Path    string
	Message string
}

// JsonOut is JSON text being written, and the context `toJson` runs in.
type JsonOut struct {
	Ctx *Ctx
	b   []byte
}

// Raw writes text that is JSON already: punctuation, keys.
func (o *JsonOut) Raw(s string) { o.b = append(o.b, s...) }

func (o *JsonOut) String() string { return string(o.b) }

// Key writes an object's next key, `"name":` already quoted, with a comma unless it is the
// first: fields that are none are left out, so which one comes first is known only here.
func (o *JsonOut) Key(quoted string) {
	if o.b[len(o.b)-1] != '{' {
		o.b = append(o.b, ',')
	}
	o.b = append(o.b, quoted...)
}

// Str writes s as a JSON string. Only quotes, backslashes and control characters are escaped.
func (o *JsonOut) Str(s string) {
	o.b = append(o.b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			o.b = append(o.b, '\\', c)
		case c == '\n':
			o.b = append(o.b, '\\', 'n')
		case c == '\r':
			o.b = append(o.b, '\\', 'r')
		case c == '\t':
			o.b = append(o.b, '\\', 't')
		case c < 0x20:
			o.b = append(o.b, `\u00`...)
			o.b = append(o.b, "0123456789abcdef"[c>>4], "0123456789abcdef"[c&0xf])
		case c < utf8.RuneSelf:
			o.b = append(o.b, c)
		default:
			r, n := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && n == 1 {
				o.b = append(o.b, `�`...)
			} else {
				o.b = append(o.b, s[i:i+n]...)
			}
			i += n
			continue
		}
		i++
	}
	o.b = append(o.b, '"')
}

// JsonObject is a parsed JSON object, keys in the order they came; a repeated key keeps its
// first place and its last value.
type JsonObject struct {
	Keys []string
	Vals map[string]any
}

// Get is the value of key, if the object has it.
func (o *JsonObject) Get(key string) (any, bool) {
	v, ok := o.Vals[key]
	return v, ok
}

// JsonParse reads one JSON value: nil, bool, json.Number, string, []any or *JsonObject.
func JsonParse(text string) (any, *JsonErr) {
	// Checked whole first: the decoder's token stream reports some errors a token early.
	var raw json.RawMessage
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		var syntax *json.SyntaxError
		switch {
		case errors.As(err, &syntax) && syntax.Error() == "unexpected end of JSON input":
			return nil, &JsonErr{Path: "$", Message: "not JSON: it ends too soon"}
		case errors.As(err, &syntax):
			return nil, &JsonErr{Path: "$", Message: "not JSON: " + syntax.Error() + " at byte " + strconv.FormatInt(syntax.Offset, 10)}
		default:
			return nil, &JsonErr{Path: "$", Message: "not JSON: " + err.Error()}
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := parseValue(d)
	if err != nil {
		return nil, &JsonErr{Path: "$", Message: "not JSON: " + err.Error()}
	}
	return v, nil
}

func parseValue(d *json.Decoder) (any, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t := t.(type) {
	case json.Delim:
		if t == '[' {
			items := []any{}
			for d.More() {
				v, err := parseValue(d)
				if err != nil {
					return nil, err
				}
				items = append(items, v)
			}
			_, err := d.Token()
			return items, err
		}
		obj := &JsonObject{Vals: map[string]any{}}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return nil, err
			}
			key := k.(string)
			v, err := parseValue(d)
			if err != nil {
				return nil, err
			}
			if _, seen := obj.Vals[key]; !seen {
				obj.Keys = append(obj.Keys, key)
			}
			obj.Vals[key] = v
		}
		_, err := d.Token()
		return obj, err
	default:
		return t, nil
	}
}

// JsonEncode writes v as compact JSON.
func JsonEncode[T any, D Json[T]](c *Ctx, v T) string {
	o := JsonOut{Ctx: c}
	(*new(D)).Enc(&o, v)
	return o.String()
}

// JsonIndent lays compact JSON out over lines, two spaces a level, as JSON.stringify(v, null, 2).
func JsonIndent(compact string) string {
	var b bytes.Buffer
	if err := json.Indent(&b, []byte(compact), "", "  "); err != nil {
		panic("json: cannot indent what encode wrote: " + err.Error())
	}
	return b.String()
}

// JsonDecode reads text as a T; strict, an object's unknown field is an error.
func JsonDecode[T any, D Json[T]](c *Ctx, text string, strict bool) (T, *JsonErr) {
	j, err := JsonParse(text)
	if err != nil {
		return *new(T), err
	}
	return (*new(D)).Dec(&JsonIn{Ctx: c, Strict: strict}, j, "$")
}

// JsonAt is the path of an object's field: `$.title`, or `$["two words"]`.
func JsonAt(path, key string) string {
	if key != "" && strings.IndexFunc(key, func(r rune) bool {
		return !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) < 0 && !(key[0] >= '0' && key[0] <= '9') {
		return path + "." + key
	}
	var o JsonOut
	o.Str(key)
	return path + "[" + o.String() + "]"
}

// JsonMissing is the error for a field an object lacks.
func JsonMissing(path, key string) *JsonErr {
	return &JsonErr{Path: JsonAt(path, key), Message: "missing"}
}

// JsonUnknown is the error for the first key of obj that isn't one of known, if any.
func JsonUnknown(obj *JsonObject, path string, known ...string) *JsonErr {
	for _, k := range obj.Keys {
		found := false
		for _, n := range known {
			if k == n {
				found = true
				break
			}
		}
		if found {
			continue
		}
		var want string
		switch len(known) {
		case 0:
			want = "no fields"
		case 1:
			want = strconv.Quote(known[0])
		default:
			quoted := make([]string, len(known))
			for i, n := range known {
				quoted[i] = strconv.Quote(n)
			}
			want = "one of " + strings.Join(quoted, ", ")
		}
		return &JsonErr{Path: JsonAt(path, k), Message: "unknown field; expected " + want}
	}
	return nil
}

// JsonBad is the error for a value of the wrong shape: "expected a string, found 3".
func JsonBad(path, want string, j any) *JsonErr {
	return &JsonErr{Path: path, Message: "expected " + want + ", found " + jsonFound(j)}
}

func jsonFound(j any) string {
	switch j := j.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(j)
	case json.Number:
		return string(j)
	case string:
		var o JsonOut
		if utf8.RuneCountInString(j) > 20 {
			o.Str(string([]rune(j)[:20]))
			return strings.TrimSuffix(o.String(), `"`) + `..."`
		}
		o.Str(j)
		return o.String()
	case []any:
		return "an array"
	default:
		return "an object"
	}
}

// JsonObjectOf is j as an object.
func JsonObjectOf(j any, path string) (*JsonObject, *JsonErr) {
	if o, ok := j.(*JsonObject); ok {
		return o, nil
	}
	return nil, JsonBad(path, "an object", j)
}

// JsonInt, JsonString and JsonBool are the dictionaries of int, string and bool.
type JsonInt struct{}

func (JsonInt) Enc(o *JsonOut, v int64) { o.b = strconv.AppendInt(o.b, v, 10) }

func (JsonInt) Dec(in *JsonIn, j any, path string) (int64, *JsonErr) {
	if n, ok := j.(json.Number); ok {
		if v, err := strconv.ParseInt(string(n), 10, 64); err == nil {
			return v, nil
		}
		if bytes.ContainsAny([]byte(n), ".eE") {
			return 0, JsonBad(path, "an integer", j)
		}
		return 0, JsonBad(path, "an integer that fits in 64 bits", j)
	}
	return 0, JsonBad(path, "an integer", j)
}

// JsonNumberOf reads a parsed number for `json.Value`: an int when it is written as one and
// fits in 64 bits, else a float; and its text as written, or "" when encoding the number gives
// that text back.
func JsonNumberOf(j any, path string) (i int64, f float64, isInt bool, text string, err *JsonErr) {
	n, ok := j.(json.Number)
	if !ok {
		return 0, 0, false, "", JsonBad(path, "JSON", j)
	}
	if !bytes.ContainsAny([]byte(n), ".eE") {
		if v, err := strconv.ParseInt(string(n), 10, 64); err == nil {
			if strconv.FormatInt(v, 10) != string(n) {
				text = string(n)
			}
			return v, 0, true, text, nil
		}
	}
	f, err = JsonFloat{}.Dec(nil, j, path)
	if err == nil && strconv.FormatFloat(f, 'g', -1, 64) != string(n) {
		text = string(n)
	}
	return 0, f, false, text, err
}

// JsonFloat is float's: a number, written as `toString` does but without the `.0` of a whole
// one, which JSON doesn't need.
type JsonFloat struct{}

func (JsonFloat) Enc(o *JsonOut, v float64) {
	o.b = strconv.AppendFloat(o.b, v, 'g', -1, 64)
}

func (JsonFloat) Dec(in *JsonIn, j any, path string) (float64, *JsonErr) {
	if n, ok := j.(json.Number); ok {
		if v, err := strconv.ParseFloat(string(n), 64); err == nil && finite(v) {
			return v, nil
		}
		return 0, JsonBad(path, "a number that fits in a float", j)
	}
	return 0, JsonBad(path, "a number", j)
}

type JsonString struct{}

func (JsonString) Enc(o *JsonOut, v string) { o.Str(v) }

func (JsonString) Dec(in *JsonIn, j any, path string) (string, *JsonErr) {
	if s, ok := j.(string); ok {
		return s, nil
	}
	return "", JsonBad(path, "a string", j)
}

type JsonBool struct{}

func (JsonBool) Enc(o *JsonOut, v bool) { o.b = strconv.AppendBool(o.b, v) }

func (JsonBool) Dec(in *JsonIn, j any, path string) (bool, *JsonErr) {
	if b, ok := j.(bool); ok {
		return b, nil
	}
	return false, JsonBad(path, "true or false", j)
}

// JsonChar is char's: a string of one code point.
type JsonChar struct{}

func (JsonChar) Enc(o *JsonOut, v rune) { o.Str(string(v)) }

func (JsonChar) Dec(in *JsonIn, j any, path string) (rune, *JsonErr) {
	if s, ok := j.(string); ok && utf8.RuneCountInString(s) == 1 {
		r, _ := utf8.DecodeRuneInString(s)
		return r, nil
	}
	return 0, JsonBad(path, "a string of one character", j)
}

// JsonBytes is Bytes': a string of standard base64, as Go's encoding/json writes []byte.
type JsonBytes struct{}

func (JsonBytes) Enc(o *JsonOut, v []byte) { o.Str(BytesBase64(v)) }

func (JsonBytes) Dec(in *JsonIn, j any, path string) ([]byte, *JsonErr) {
	if s, ok := j.(string); ok {
		if b, ok := BytesFromBase64(s); ok {
			return b, nil
		}
	}
	return nil, JsonBad(path, "a string of base64", j)
}

// JsonList is the dictionary of List<T>: an array.
type JsonList[T any, D Json[T]] struct{}

func (JsonList[T, D]) Enc(o *JsonOut, v []T) {
	o.Raw("[")
	for i, x := range v {
		if i > 0 {
			o.Raw(",")
		}
		(*new(D)).Enc(o, x)
	}
	o.Raw("]")
}

func (JsonList[T, D]) Dec(in *JsonIn, j any, path string) ([]T, *JsonErr) {
	items, ok := j.([]any)
	if !ok {
		return nil, JsonBad(path, "an array", j)
	}
	out := make([]T, len(items))
	for i, x := range items {
		v, err := (*new(D)).Dec(in, x, path+"["+strconv.Itoa(i)+"]")
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

// JsonMap is the dictionary of Map<string, T>: an object, keys in order.
type JsonMap[T any, D Json[T]] struct{}

func (JsonMap[T, D]) Enc(o *JsonOut, v Map[string, T]) {
	o.Raw("{")
	for i, e := range v.Entries() {
		if i > 0 {
			o.Raw(",")
		}
		o.Str(e.Key)
		o.Raw(":")
		(*new(D)).Enc(o, e.Value)
	}
	o.Raw("}")
}

func (JsonMap[T, D]) Dec(in *JsonIn, j any, path string) (Map[string, T], *JsonErr) {
	obj, err := JsonObjectOf(j, path)
	if err != nil {
		return Map[string, T]{}, err
	}
	entries := make([]MapEntry[string, T], len(obj.Keys))
	for i, k := range obj.Keys {
		v, err := (*new(D)).Dec(in, obj.Vals[k], JsonAt(path, k))
		if err != nil {
			return Map[string, T]{}, err
		}
		entries[i] = MapEntry[string, T]{Key: k, Value: v}
	}
	return MapOf(entries), nil
}
