package candor

import "testing"

func TestArg(t *testing.T) {
	if v := Arg[any](int64(7)); v != int64(7) {
		t.Fatalf("Arg[any] = %#v", v)
	}
	if v := Arg[int](int64(7)); v != 7 {
		t.Fatalf("Arg[int] = %#v", v)
	}
	if v := Arg[string]("x"); v != "x" {
		t.Fatalf("Arg[string] = %#v", v)
	}
}
