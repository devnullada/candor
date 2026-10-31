package candor

import (
	"fmt"
	"math"
)

// Integer arithmetic traps on overflow (card 052): a result that doesn't fit in 64 bits is a
// bug, not a number. `a.wrappingAdd(b)` and its kin are Go's plain operators.

// Kept out of line, so the operations stay small enough for Go to inline them.
//
//go:noinline
func overflow(a int64, op string, b int64) {
	panic(fmt.Sprintf("integer overflow: %d %s %d doesn't fit in an int", a, op, b))
}

func Add(a, b int64) int64 {
	c := a + b
	if (c > a) != (b > 0) {
		overflow(a, "+", b)
	}
	return c
}

func Sub(a, b int64) int64 {
	c := a - b
	if (c < a) != (b > 0) {
		overflow(a, "-", b)
	}
	return c
}

func Mul(a, b int64) int64 {
	// Both within 32 bits, the usual case: the product fits.
	if uint64(a+1<<31) < 1<<32 && uint64(b+1<<31) < 1<<32 {
		return a * b
	}
	return mulWide(a, b)
}

//go:noinline
func mulWide(a, b int64) int64 {
	if a == 0 || b == 0 {
		return 0
	}
	c := a * b
	if c/b != a || (a == -1 && b == math.MinInt64) || (b == -1 && a == math.MinInt64) {
		overflow(a, "*", b)
	}
	return c
}

func Neg(a int64) int64 {
	if a == math.MinInt64 {
		negOverflow(a)
	}
	return -a
}

//go:noinline
func negOverflow(a int64) {
	panic(fmt.Sprintf("integer overflow: -(%d) doesn't fit in an int", a))
}

// The wrapping operations, asked for by name: `h.wrappingMul(31)`.
func WrappingAdd(a, b int64) int64 { return a + b }
func WrappingSub(a, b int64) int64 { return a - b }
func WrappingMul(a, b int64) int64 { return a * b }

// The shifts, `n.shl(k)` and kin: bits shifted out are gone, never an overflow. A count outside
// 0 to 63 panics, as it is a mistake (Go would give 0 or -1).
func Shl(a, k int64) int64  { return a << shiftCount("shl", a, k) }
func Shr(a, k int64) int64  { return a >> shiftCount("shr", a, k) }
func Ushr(a, k int64) int64 { return int64(uint64(a) >> shiftCount("ushr", a, k)) }

func shiftCount(op string, a, k int64) uint {
	if k < 0 || k > 63 {
		panic(fmt.Sprintf("%s(): (%d).%s(%d) shifts by %d; the count is 0 to 63", op, a, op, k, k))
	}
	return uint(k)
}

// The checked operations, for code that expects the failure: `a.checkedDiv(b) ?? 0`. The bool is
// false on overflow or a zero divisor.
func CheckedAdd(a, b int64) (int64, bool) {
	c := a + b
	return c, (c > a) == (b > 0)
}

func CheckedSub(a, b int64) (int64, bool) {
	c := a - b
	return c, (c < a) == (b > 0)
}

func CheckedMul(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	c := a * b
	if c/b != a || (a == -1 && b == math.MinInt64) || (b == -1 && a == math.MinInt64) {
		return 0, false
	}
	return c, true
}

func CheckedDiv(a, b int64) (int64, bool) {
	if b == 0 || (b == -1 && a == math.MinInt64) {
		return 0, false
	}
	return a / b, true
}

// Min and Max are `a.min(b)` and `a.max(b)` on ints and floats. Functions, not Go's builtins: a
// local variable may be named `min`.
func Min[T int64 | float64](a, b T) T { return min(a, b) }
func Max[T int64 | float64](a, b T) T { return max(a, b) }

// AbsInt is `n.abs()`: MinInt64 has no positive twin.
func AbsInt(a int64) int64 {
	if a == math.MinInt64 {
		panic(fmt.Sprintf("integer overflow: (%d).abs() doesn't fit in an int", a))
	}
	if a < 0 {
		return -a
	}
	return a
}

// PowInt is `n.pow(k)`, by squaring; overflow and a negative exponent panic.
func PowInt(a, k int64) int64 {
	if k < 0 {
		panic(fmt.Sprintf("pow(): %d.pow(%d) has a negative exponent; for a fraction, use floats: `n.toFloat().pow(k.toFloat())`", a, k))
	}
	r, base := int64(1), a
	for e := k; e > 0; e >>= 1 {
		if e&1 == 1 {
			c, ok := CheckedMul(r, base)
			if !ok {
				panic(fmt.Sprintf("integer overflow: %d.pow(%d) doesn't fit in an int", a, k))
			}
			r = c
		}
		if e > 1 {
			c, ok := CheckedMul(base, base)
			if !ok {
				panic(fmt.Sprintf("integer overflow: %d.pow(%d) doesn't fit in an int", a, k))
			}
			base = c
		}
	}
	return r
}

// Go panics on a zero divisor itself, and gives MinInt64 for MinInt64 / -1, the one overflow.
// (`%` can't overflow: MinInt64 % -1 is 0.)
func Div(a, b int64) int64 {
	if b == -1 && a == math.MinInt64 {
		overflow(a, "/", b)
	}
	return a / b
}
