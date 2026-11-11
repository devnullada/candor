package candor

import (
	"reflect"
	"strconv"
)

// GoError is an error from Go, as a binding's `Result<T, GoError>` gives it. Candor sees its
// message and can ask whether it is, or wraps, a known error (`errors.Is`); the chain is kept.
type GoError struct {
	Err error
}

func (e GoError) Show__() string { return "GoError(" + strconv.Quote(e.Err.Error()) + ")" }

// Integer is every Go integer type: a Candor int reaches any of them through a binding.
type Integer interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 | ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// Float is every Go float type: a Candor float reaches either through a binding.
type Float interface {
	~float32 | ~float64
}

// Arg converts a value a binding passes into a Go variadic parameter of type V: as it is for
// `...any`, and converted (an int64 to an int, say) for a typed one. The binding was checked
// against Go's types, so the conversion exists.
func Arg[V any](x any) V {
	if v, ok := x.(V); ok {
		return v
	}
	return reflect.ValueOf(x).Convert(reflect.TypeFor[V]()).Interface().(V)
}
