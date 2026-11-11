package candor

import (
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Map is a Candor `Map<K, V>`: a value, iterated in insertion order. The zero value is empty.
//
// Go maps are references, so a write must not reach other copies. A `let mut` variable writes
// in place only while it owns the data: owner points at the variable. Reading the variable as
// a value (passing it, storing it, returning it) calls Share, which clears the owner, so the
// next write through either copy copies first. Writes through a struct field always copy.
type Map[K any, V any] struct {
	_ mapMarker
	d *mapData[K, V]
}

// mapMarker tells maps apart from other structs when keys are encoded by reflection.
type mapMarker struct{}

// MapEntry is one key and its value. Removed entries stay in place, dead, until compaction.
type MapEntry[K any, V any] struct {
	Key   K
	Value V
	dead  bool
}

type mapData[K any, V any] struct {
	// From each key's Go map key (see keyOf) to its entry.
	index   map[any]int
	entries []MapEntry[K, V]
	dead    int
	owner   *Map[K, V]
}

// MapOf builds a map literal. A key given twice keeps its last value.
func MapOf[K any, V any](entries []MapEntry[K, V]) Map[K, V] {
	var m Map[K, V]
	for _, e := range entries {
		m.Set(e.Key, e.Value)
	}
	m.Share()
	return m
}

func (m Map[K, V]) Len() int64 {
	if m.d == nil {
		return 0
	}
	return int64(len(m.d.entries) - m.d.dead)
}

func (m Map[K, V]) Get(k K) (V, bool) {
	if m.d != nil {
		if i, ok := m.d.index[keyOf(k)]; ok {
			return m.d.entries[i].Value, true
		}
	}
	var zero V
	return zero, false
}

func (m Map[K, V]) Has(k K) bool {
	_, ok := m.Get(k)
	return ok
}

// Entries are the live entries, in insertion order. Not to be changed.
func (m Map[K, V]) Entries() []MapEntry[K, V] {
	if m.d == nil {
		return nil
	}
	if m.d.dead == 0 {
		return m.d.entries[:len(m.d.entries):len(m.d.entries)]
	}
	out := make([]MapEntry[K, V], 0, len(m.d.entries)-m.d.dead)
	for _, e := range m.d.entries {
		if !e.dead {
			out = append(out, e)
		}
	}
	return out
}

func (m Map[K, V]) Keys() []K {
	out := make([]K, 0, m.Len())
	for _, e := range m.Entries() {
		out = append(out, e.Key)
	}
	return out
}

func (m Map[K, V]) Values() []V {
	out := make([]V, 0, m.Len())
	for _, e := range m.Entries() {
		out = append(out, e.Value)
	}
	return out
}

// Share marks the map as no longer owned by the variable it is read from: see Map.
func (m Map[K, V]) Share() Map[K, V] {
	if m.d != nil && m.d.owner != nil {
		m.d.owner = nil
	}
	return m
}

// Set gives k the value v, in place when the variable m owns its data.
func (m *Map[K, V]) Set(k K, v V) {
	m.own(m)
	m.set(k, v)
}

// SetCopy is Set on a map that may be shared: a struct field.
func (m *Map[K, V]) SetCopy(k K, v V) {
	m.own(nil)
	m.set(k, v)
}

func (m *Map[K, V]) set(k K, v V) {
	key := keyOf(k)
	if i, ok := m.d.index[key]; ok {
		m.d.entries[i].Value = v
		return
	}
	m.d.index[key] = len(m.d.entries)
	m.d.entries = append(m.d.entries, MapEntry[K, V]{Key: k, Value: v})
}

// Remove takes k out, returning its value if it had one.
func (m *Map[K, V]) Remove(k K) (V, bool) {
	return m.remove(k, m)
}

func (m *Map[K, V]) RemoveCopy(k K) (V, bool) {
	return m.remove(k, nil)
}

func (m *Map[K, V]) remove(k K, owner *Map[K, V]) (V, bool) {
	var zero V
	if !m.Has(k) {
		return zero, false
	}
	m.own(owner)
	key := keyOf(k)
	i := m.d.index[key]
	v := m.d.entries[i].Value
	delete(m.d.index, key)
	m.d.entries[i] = MapEntry[K, V]{dead: true}
	m.d.dead++
	if m.d.dead > 8 && m.d.dead*2 > len(m.d.entries) {
		m.d = m.d.compact(owner)
	}
	return v, true
}

// own makes m's data safe to change: a copy, unless owner already owns it.
func (m *Map[K, V]) own(owner *Map[K, V]) {
	if m.d != nil && owner != nil && m.d.owner == owner {
		return
	}
	if m.d == nil {
		m.d = &mapData[K, V]{index: map[any]int{}, owner: owner}
		return
	}
	m.d = m.d.compact(owner)
}

// compact copies the live entries into new data.
func (d *mapData[K, V]) compact(owner *Map[K, V]) *mapData[K, V] {
	n := len(d.entries) - d.dead
	out := &mapData[K, V]{index: make(map[any]int, n), entries: make([]MapEntry[K, V], 0, n), owner: owner}
	for _, e := range d.entries {
		if !e.dead {
			out.index[keyOf(e.Key)] = len(out.entries)
			out.entries = append(out.entries, e)
		}
	}
	return out
}

// MapEq is `==` on maps: the same keys, with equal values. Order doesn't matter.
func MapEq[K any, V any](a, b Map[K, V], eq func(V, V) bool) bool {
	if a.Len() != b.Len() {
		return false
	}
	for _, e := range a.Entries() {
		v, ok := b.Get(e.Key)
		if !ok || !eq(e.Value, v) {
			return false
		}
	}
	return true
}

func (m Map[K, V]) Show__() string {
	if m.Len() == 0 {
		return "[:]"
	}
	parts := make([]string, 0, m.Len())
	for _, e := range m.Entries() {
		parts = append(parts, Show(e.Key)+": "+Show(e.Value))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// keyOf is what a key is stored under in Go's map. Keys Go's `==` compares as Candor does are
// stored as they are; others (with lists, maps, or fields behind pointers) as a string that
// encodes their value, so equal keys meet.
func keyOf[K any](k K) any {
	t := reflect.TypeOf((*K)(nil)).Elem()
	if simpleKey(t) {
		return k
	}
	var b strings.Builder
	encodeKey(&b, reflect.ValueOf(&k).Elem())
	return b.String()
}

var simpleKeys sync.Map // reflect.Type -> bool

func simpleKey(t reflect.Type) bool {
	if v, ok := simpleKeys.Load(t); ok {
		return v.(bool)
	}
	ok := isSimple(t)
	simpleKeys.Store(t, ok)
	return ok
}

func isSimple(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Bool, reflect.Int, reflect.Int32, reflect.Int64, reflect.Float64, reflect.String:
		return true
	case reflect.Struct:
		if t.NumField() > 0 && t.Field(0).Type == reflect.TypeOf(mapMarker{}) {
			return false
		}
		for i := 0; i < t.NumField(); i++ {
			if !isSimple(t.Field(i).Type) {
				return false
			}
		}
		return true
	case reflect.Array:
		return isSimple(t.Elem())
	}
	return false
}

// encodeKey writes v so that two values encode the same exactly when Candor's `==` holds.
func encodeKey(b *strings.Builder, v reflect.Value) {
	switch v.Kind() {
	case reflect.Bool:
		if v.Bool() {
			b.WriteByte('t')
		} else {
			b.WriteByte('f')
		}
	case reflect.Int, reflect.Int32, reflect.Int64:
		b.WriteString(strconv.FormatInt(v.Int(), 10))
		b.WriteByte(';')
	case reflect.Float64:
		// -0.0 == 0.0, so they are one key.
		f := v.Float()
		if f == 0 {
			f = 0
		}
		b.WriteString(strconv.FormatFloat(f, 'g', -1, 64))
		b.WriteByte(';')
	case reflect.String:
		s := v.String()
		b.WriteString(strconv.Itoa(len(s)))
		b.WriteByte(':')
		b.WriteString(s)
	case reflect.Slice:
		b.WriteByte('[')
		b.WriteString(strconv.Itoa(v.Len()))
		b.WriteByte(';')
		if v.Type().Elem().Kind() == reflect.Uint8 {
			// Bytes: the length says where they end.
			b.Write(v.Bytes())
			return
		}
		for i := 0; i < v.Len(); i++ {
			encodeKey(b, v.Index(i))
		}
	case reflect.Pointer:
		if v.IsNil() {
			b.WriteByte('n')
		} else {
			b.WriteByte('p')
			encodeKey(b, v.Elem())
		}
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			encodeKey(b, v.Index(i))
		}
	case reflect.Struct:
		if v.NumField() > 0 && v.Type().Field(0).Type == reflect.TypeOf(mapMarker{}) {
			encodeMap(b, v.Field(1))
			return
		}
		b.WriteByte('{')
		for i := 0; i < v.NumField(); i++ {
			encodeKey(b, v.Field(i))
		}
		b.WriteByte('}')
	default:
		panic("candor: cannot use a " + v.Type().String() + " as a map key")
	}
}

// encodeMap writes a map's entries sorted by their encoding, since order doesn't count for `==`.
func encodeMap(b *strings.Builder, d reflect.Value) {
	var parts []string
	if !d.IsNil() {
		entries := d.Elem().FieldByName("entries")
		for i := 0; i < entries.Len(); i++ {
			e := entries.Index(i)
			if e.FieldByName("dead").Bool() {
				continue
			}
			var p strings.Builder
			encodeKey(&p, e.FieldByName("Key"))
			encodeKey(&p, e.FieldByName("Value"))
			parts = append(parts, p.String())
		}
	}
	sort.Strings(parts)
	b.WriteString("M")
	b.WriteString(strconv.Itoa(len(parts)))
	b.WriteByte(';')
	for _, p := range parts {
		b.WriteString(strconv.Itoa(len(p)))
		b.WriteByte(':')
		b.WriteString(p)
	}
}
