package candor

import "testing"

func TestMapOrderAndCopies(t *testing.T) {
	var m Map[string, int64]
	m.Set("b", 1)
	m.Set("a", 2)
	m.Set("b", 3)
	if got := Show(m); got != `["b": 3, "a": 2]` {
		t.Fatalf("got %s", got)
	}
	c := m.Share()
	m.Set("c", 4)
	if c.Len() != 2 || m.Len() != 3 {
		t.Fatalf("a copy saw a write: %d %d", c.Len(), m.Len())
	}
	// The write after sharing copied; later ones are in place again.
	d := m.d
	m.Set("d", 5)
	if m.d != d {
		t.Fatal("an owned map copied")
	}
	// A copy taken by struct field writes never owns.
	s := struct{ f Map[string, int64] }{m.Share()}
	s.f.SetCopy("e", 6)
	before := s
	s.f.SetCopy("f", 7)
	if before.f.Len() != 5 || s.f.Len() != 6 {
		t.Fatal("a struct copy saw a write")
	}
}

func TestMapRemove(t *testing.T) {
	var m Map[int64, int64]
	for i := int64(0); i < 40; i++ {
		m.Set(i, i*i)
	}
	shared := m.Share()
	for i := int64(0); i < 30; i++ {
		if v, ok := m.Remove(i); !ok || v != i*i {
			t.Fatalf("remove %d: %d %v", i, v, ok)
		}
	}
	if _, ok := m.Remove(0); ok {
		t.Fatal("removed twice")
	}
	if m.Len() != 10 || shared.Len() != 40 || m.Keys()[0] != 30 {
		t.Fatalf("%d %d %v", m.Len(), shared.Len(), m.Keys())
	}
	if v, _ := m.Get(39); v != 39*39 {
		t.Fatal("lost a value in compaction")
	}
}

func TestMapDeepKeys(t *testing.T) {
	type pair struct {
		xs []int64
		p  *int64
	}
	one, one2 := int64(1), int64(1)
	var m Map[pair, string]
	m.Set(pair{[]int64{1, 2}, &one}, "x")
	if _, ok := m.Get(pair{[]int64{1, 2}, &one2}); !ok {
		t.Fatal("equal keys did not meet")
	}
	if m.Has(pair{[]int64{1}, &one}) || m.Has(pair{[]int64{1, 2}, nil}) {
		t.Fatal("unequal keys met")
	}
	var a, b Map[string, int64]
	a.Set("x", 1)
	a.Set("y", 2)
	b.Set("y", 2)
	b.Set("x", 1)
	var mm Map[Map[string, int64], bool]
	mm.Set(a, true)
	if !mm.Has(b) || !MapEq(a, b, func(x, y int64) bool { return x == y }) {
		t.Fatal("maps as keys ignore order")
	}
}
