package candor

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Floats are 64-bit and never NaN or infinite: an operation that would make one
// panics with the line, as int overflow does, so `==` and `<` stay a total order.

//go:noinline
func notFinite(a float64, op string, b float64, r float64) {
	if math.IsNaN(r) {
		panic(fmt.Sprintf("float error: %s %s %s is not a number", FloatString(a), op, FloatString(b)))
	}
	panic(fmt.Sprintf("float overflow: %s %s %s doesn't fit in a float", FloatString(a), op, FloatString(b)))
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func FAdd(a, b float64) float64 {
	r := a + b
	if !finite(r) {
		notFinite(a, "+", b, r)
	}
	return r
}

func FSub(a, b float64) float64 {
	r := a - b
	if !finite(r) {
		notFinite(a, "-", b, r)
	}
	return r
}

func FMul(a, b float64) float64 {
	r := a * b
	if !finite(r) {
		notFinite(a, "*", b, r)
	}
	return r
}

func FDiv(a, b float64) float64 {
	if b == 0 {
		panic(fmt.Sprintf("division by zero: %s / %s", FloatString(a), FloatString(b)))
	}
	r := a / b
	if !finite(r) {
		notFinite(a, "/", b, r)
	}
	return r
}

// FMod is `a % b` on floats: the sign of the dividend, as on ints (Go's math.Mod).
func FMod(a, b float64) float64 {
	if b == 0 {
		panic(fmt.Sprintf("division by zero: %s %% %s", FloatString(a), FloatString(b)))
	}
	return math.Mod(a, b)
}

// Pow is `x.pow(y)`; a result that is NaN or infinite panics.
func Pow(x, y float64) float64 {
	r := math.Pow(x, y)
	if math.IsNaN(r) {
		panic(fmt.Sprintf("pow(): (%s).pow(%s) is not a number", FloatString(x), FloatString(y)))
	}
	if math.IsInf(r, 0) {
		panic(fmt.Sprintf("pow(): (%s).pow(%s) doesn't fit in a float", FloatString(x), FloatString(y)))
	}
	return r
}

// FromGoFloat is a float a Go function gave a binding: NaN and infinity panic, naming the function.
func FromGoFloat(f float64, goName string) float64 {
	if !finite(f) {
		panic(fmt.Sprintf("candor: the Go function %s gave %v, which a Candor float never is", goName, f))
	}
	return f
}

// FloatString is `f.toString()`: the shortest text that reads back as the same float, with a
// `.0` on a whole number, and an exponent only for the very large and very small: 1.5, 2.0,
// 0.001, 1e+21, 1e-07.
func FloatString(f float64) string {
	abs := math.Abs(f)
	var s string
	if abs != 0 && (abs < 1e-6 || abs >= 1e21) {
		s = strconv.FormatFloat(f, 'e', -1, 64)
	} else {
		s = strconv.FormatFloat(f, 'f', -1, 64)
	}
	if !strings.ContainsAny(s, ".e") {
		s += ".0"
	}
	return s
}

// ToFixed is `f.toFixed(n)`: n digits after the point, rounded.
func ToFixed(f float64, digits int64) string {
	if digits < 0 || digits > 100 {
		panic(fmt.Sprintf("toFixed(%d): the digits must be from 0 to 100", digits))
	}
	return strconv.FormatFloat(f, 'f', int(digits), 64)
}

// ToInt is a whole float as an int, for round, floor, ceil and truncate; out of range panics.
func ToInt(f float64, how string) int64 {
	// 2^63 is exact as a float; every float below it in magnitude fits.
	if f >= 9.223372036854775808e18 || f < -9.223372036854775808e18 {
		panic(fmt.Sprintf("%s(): %s doesn't fit in an int", how, FloatString(f)))
	}
	return int64(f)
}

func Round(f float64) int64    { return ToInt(math.Round(f), "round") }
func Floor(f float64) int64    { return ToInt(math.Floor(f), "floor") }
func Ceil(f float64) int64     { return ToInt(math.Ceil(f), "ceil") }
func Truncate(f float64) int64 { return ToInt(math.Trunc(f), "truncate") }

func Sqrt(f float64) float64 {
	if f < 0 {
		panic(fmt.Sprintf("sqrt(): %s is negative", FloatString(f)))
	}
	return math.Sqrt(f)
}

// ParseFloat is `s.toFloat()`: decimal text (`1.5`, `-2`, `3e8`), or none.
func ParseFloat(s string) (float64, bool) {
	if s == "" || strings.ContainsAny(s, "xXpP_") {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || !finite(f) {
		return 0, false
	}
	return f, true
}

// SumFloats is `xs.sum()` on a List<float>.
func SumFloats(xs []float64) float64 {
	total := 0.0
	for _, x := range xs {
		total = FAdd(total, x)
	}
	return total
}
