package candor

import (
	"slices"
	"testing"
)

func TestToChar(t *testing.T) {
	if c, ok := ToChar(233); !ok || c != 'é' {
		t.Fatalf("ToChar(233) = %q, %v", c, ok)
	}
	for _, n := range []int64{-1, 0xD800, 0x110000, 1 << 40} {
		if _, ok := ToChar(n); ok {
			t.Fatalf("ToChar(%d) is a char", n)
		}
	}
}

func TestIndexOfCountsCodePoints(t *testing.T) {
	if i, ok := IndexOf("héllo", "llo"); !ok || i != 2 {
		t.Fatalf("IndexOf = %d, %v", i, ok)
	}
	if _, ok := IndexOf("héllo", "x"); ok {
		t.Fatal("found what is not there")
	}
	if i, ok := IndexOf("abc", ""); !ok || i != 0 {
		t.Fatalf("the empty string is at %d, %v", i, ok)
	}
}

func TestSliceClamps(t *testing.T) {
	cases := []struct {
		a, b int64
		want string
	}{
		{1, 3, "él"}, {3, 100, "lo"}, {3, 1, ""}, {0, 0, ""}, {10, 20, ""}, {0, 5, "héllo"},
		{-1, 2, "hé"}, {-10, -2, ""}, {2, -1, ""},
	}
	for _, c := range cases {
		if got := Slice("héllo", c.a, c.b); got != c.want {
			t.Errorf("Slice(%d, %d) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
	xs := []int{1, 2, 3}
	if got := SliceList(xs, -7, 2); !slices.Equal(got, []int{1, 2}) {
		t.Errorf("SliceList(-7, 2) = %v", got)
	}
	if got := SliceList(xs, 1, -1); len(got) != 0 {
		t.Errorf("SliceList(1, -1) = %v", got)
	}
}

func TestRepeatAndParseInt(t *testing.T) {
	if Repeat("ab", 3) != "ababab" || Repeat("ab", 0) != "" {
		t.Fatal("Repeat")
	}
	cases := map[string]struct {
		n  int64
		ok bool
	}{
		"42": {42, true}, "-7": {-7, true}, "+5": {5, true},
		"4 2": {0, false}, "": {0, false}, "9223372036854775808": {0, false}, "1_000": {0, false}, "0x10": {0, false},
	}
	for s, want := range cases {
		n, ok := ParseInt(s)
		if ok != want.ok || (ok && n != want.n) {
			t.Errorf("ParseInt(%q) = %d, %v", s, n, ok)
		}
	}
	defer func() {
		if recover() == nil {
			t.Fatal("no panic for a negative count")
		}
	}()
	Repeat("x", -1)
}
