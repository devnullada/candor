package candor

import "testing"

type intList = JsonList[int64, JsonInt]

func TestJsonEncode(t *testing.T) {
	m := MapOf([]MapEntry[string, []int64]{{Key: "b", Value: []int64{1, 2}}, {Key: "a b", Value: nil}})
	got := JsonEncode[Map[string, []int64], JsonMap[[]int64, intList]](nil, m)
	if want := `{"b":[1,2],"a b":[]}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	s := JsonEncode[string, JsonString](nil, "q\"\\\n\x01é👋\xff")
	if want := `"q\"\\\n\u0001é👋�"`; s != want {
		t.Fatalf("got %s, want %s", s, want)
	}
}

func TestJsonDecode(t *testing.T) {
	m, err := JsonDecode[Map[string, []int64], JsonMap[[]int64, intList]](nil, ` {"z": [3], "a": [], "z": [4]} `, false)
	if err != nil {
		t.Fatal(err.Path, err.Message)
	}
	if m.Len() != 2 || m.Keys()[0] != "z" {
		t.Fatalf("keys %v", m.Keys())
	}
	if v, _ := m.Get("z"); len(v) != 1 || v[0] != 4 {
		t.Fatalf("z is %v: the last value wins", v)
	}
	s, err := JsonDecode[string, JsonString](nil, `"é👋"`, false)
	if err != nil || s != "é👋" {
		t.Fatalf("got %q, %v", s, err)
	}
}

func TestJsonErrors(t *testing.T) {
	cases := []struct{ text, path, msg string }{
		{`{"a": [1, "x"]}`, `$.a[1]`, `expected an integer, found "x"`},
		{`{"two words": [1.5]}`, `$["two words"][0]`, `expected an integer, found 1.5`},
		{`{"a": [99999999999999999999]}`, `$.a[0]`, `expected an integer that fits in 64 bits, found 99999999999999999999`},
		{`[1]`, `$`, `expected an object, found an array`},
		{`{"a": null}`, `$.a`, `expected an array, found null`},
		{`{"a": [1]} x`, `$`, `not JSON: invalid character 'x' after top-level value at byte 12`},
		{`{"a": [1`, `$`, `not JSON: it ends too soon`},
		{`{"a": [1,]}`, `$`, `not JSON: invalid character ']' looking for beginning of value at byte 10`},
	}
	for _, c := range cases {
		_, err := JsonDecode[Map[string, []int64], JsonMap[[]int64, intList]](nil, c.text, false)
		if err == nil || err.Path != c.path || err.Message != c.msg {
			t.Errorf("%s: got %+v, want %s: %s", c.text, err, c.path, c.msg)
		}
	}
	_, err := JsonDecode[string, JsonString](nil, `"a very long string that goes on and on"`, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = JsonDecode[bool, JsonBool](nil, `"a very long string that goes on and on"`, false)
	if err == nil || err.Message != `expected true or false, found "a very long string t..."` {
		t.Fatalf("got %+v", err)
	}
}
