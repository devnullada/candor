package candor

import (
	"fmt"
	"slices"
)

// CheckIndex panics unless i is an index of a list of n items. A read out of range is `none`;
// a write out of range is a bug, as in Swift: `xs[i] = v`, `xs[i] += v`.
func CheckIndex(i int64, n int) {
	if i < 0 || i >= int64(n) {
		panic(fmt.Sprintf("index %d out of range: the list has length %d", i, n))
	}
}

// SliceList is `xs.slice(start, end)`: a copy of the items from start up to end, both clamped
// to the list, as for strings (a negative one to 0).
func SliceList[T any](xs []T, start, end int64) []T {
	start = max(start, 0)
	end = min(end, int64(len(xs)))
	if end <= start {
		return []T{}
	}
	return slices.Clone(xs[start:end])
}

// Reversed is `xs.reversed()`: a copy, last item first.
func Reversed[T any](xs []T) []T {
	out := slices.Clone(xs)
	slices.Reverse(out)
	if out == nil {
		return []T{}
	}
	return out
}

// Unique is `xs.unique()`: each item once, where it first appears.
func Unique[T comparable](xs []T) []T {
	seen := make(map[T]bool, len(xs))
	out := []T{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// Union is `xs.union(ys)`: the items of either, each once, xs's first and then ys's new ones.
func Union[T comparable](xs, ys []T) []T {
	return Unique(slices.Concat(xs, ys))
}

// Intersect is `xs.intersect(ys)`: the items of xs that ys has too, each once, in xs's order.
func Intersect[T comparable](xs, ys []T) []T {
	in := make(map[T]bool, len(ys))
	for _, y := range ys {
		in[y] = true
	}
	out := []T{}
	for _, x := range xs {
		if in[x] {
			in[x] = false
			out = append(out, x)
		}
	}
	return out
}

// UniqueEq is Unique for items Go's == can't compare (lists, bytes, type parameters): eq
// compares them, item by item, so it takes time in the square of the length.
func UniqueEq[T any](xs []T, eq func(a, b T) bool) []T {
	out := []T{}
	for _, x := range xs {
		if !slices.ContainsFunc(out, func(y T) bool { return eq(x, y) }) {
			out = append(out, x)
		}
	}
	return out
}

// UnionEq is Union with eq.
func UnionEq[T any](xs, ys []T, eq func(a, b T) bool) []T {
	return UniqueEq(slices.Concat(xs, ys), eq)
}

// IntersectEq is Intersect with eq.
func IntersectEq[T any](xs, ys []T, eq func(a, b T) bool) []T {
	out := []T{}
	for _, x := range xs {
		has := func(y T) bool { return eq(x, y) }
		if slices.ContainsFunc(ys, has) && !slices.ContainsFunc(out, has) {
			out = append(out, x)
		}
	}
	return out
}

// Range is `a..b` as a value: the ints from a up to b - 1, none when b <= a. (`for i in a..b`
// counts without it.)
func Range(a, b int64) []int64 {
	if b <= a {
		return []int64{}
	}
	out := make([]int64, 0, b-a)
	for i := a; i < b; i++ {
		out = append(out, i)
	}
	return out
}
