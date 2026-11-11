package candor

import (
	"math"
	"strings"
	"testing"
)

func overflows(f func()) (msg string) {
	defer func() {
		if p := recover(); p != nil {
			msg = p.(string)
		}
	}()
	f()
	return ""
}

func TestIntsTrap(t *testing.T) {
	const max, min = math.MaxInt64, math.MinInt64
	traps := map[string]func(){
		"max + 1":   func() { Add(max, 1) },
		"min + -1":  func() { Add(min, -1) },
		"min - 1":   func() { Sub(min, 1) },
		"max - -1":  func() { Sub(max, -1) },
		"0 - min":   func() { Sub(0, min) },
		"max * 2":   func() { Mul(max, 2) },
		"min * -1":  func() { Mul(min, -1) },
		"-1 * min":  func() { Mul(-1, min) },
		"big * big": func() { Mul(1_800_000_000_000, 1_000_000_000) },
		"-min":      func() { Neg(min) },
		"min / -1":  func() { Div(min, -1) },
	}
	for name, f := range traps {
		if msg := overflows(f); !strings.HasPrefix(msg, "integer overflow: ") {
			t.Errorf("%s: %q", name, msg)
		}
	}
	if Add(max, -1) != max-1 || Add(min, 1) != min+1 || Sub(-1, max) != min || Sub(min, -1) != min+1 {
		t.Error("add/sub near the edges")
	}
	if Mul(min, 1) != min || Mul(-1, max) != -max || Mul(0, min) != 0 || Mul(-3, 4) != -12 || Mul(1<<31, 1<<31) != 1<<62 {
		t.Error("mul")
	}
	if Neg(max) != -max || Div(min, 1) != min || Div(-7, 2) != -3 {
		t.Error("neg/div")
	}
	if msg := overflows(func() { Add(max, 1) }); msg != "integer overflow: 9223372036854775807 + 1 doesn't fit in an int" {
		t.Error(msg)
	}
}
