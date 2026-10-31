package candor

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A Candor reader may give more than it was asked for, or empty pieces; lines still come whole.
func TestReadLinesOverOddPieces(t *testing.T) {
	pieces := [][]byte{[]byte("one\r\ntw"), {}, []byte("o\nthree"), []byte(" and a long tail\nlast")}
	i := 0
	pull := Pull(func(c *Ctx, n int64) ([]byte, bool, error) {
		if i == len(pieces) {
			return nil, false, nil
		}
		i++
		return pieces[i-1], true, nil
	})
	var lines []string
	if err := ReadLines(Root(), pull, func(_ *Ctx, l string) { lines = append(lines, l) }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"one", "two", "three and a long tail", "last"}; !slices.Equal(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

// A reader's error is what the caller sees, as it was.
func TestReadLinesKeepsTheReadersError(t *testing.T) {
	pull := Pull(func(c *Ctx, n int64) ([]byte, bool, error) { return nil, false, StreamErr("disk gone") })
	if err := ReadLines(Root(), pull, func(*Ctx, string) {}); err == nil || err.Error() != "disk gone" {
		t.Fatalf("err = %v", err)
	}
}

func TestPullBytesAndCopy(t *testing.T) {
	data := make([]byte, 3*pullSize+5)
	for i := range data {
		data[i] = byte(i)
	}
	got := Collect(func(w Push) {
		if n, err := Copy(Root(), PullBytes(data), w); err != nil || n != int64(len(data)) {
			t.Fatalf("copy = %d, %v", n, err)
		}
	})
	if !slices.Equal(got, data) {
		t.Fatal("copied bytes differ")
	}
	// Below 1 is a buffer's worth.
	if b, more, _ := PullBytes(data)(Root(), 0); !more || len(b) != pullSize {
		t.Fatalf("read of 0 = %d bytes", len(b))
	}
}

// Writing replaces the file only once use says so, and leaves nothing beside it otherwise.
func TestWritingKeepsTheOldFileOnFailure(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "data.db")
	if err := os.WriteFile(p, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs := RealFS()
	if e := fs.Writing(Root(), p, func(w Push) bool { w(Root(), []byte("half")); return false }); e != nil {
		t.Fatal(e)
	}
	if b, _ := os.ReadFile(p); string(b) != "old" {
		t.Fatalf("after a failed write: %q", b)
	}
	var late Push
	if e := fs.Writing(Root(), p, func(w Push) bool { late = w; return w(Root(), []byte("new")) == nil }); e != nil {
		t.Fatal(e)
	}
	if b, _ := os.ReadFile(p); string(b) != "new" {
		t.Fatalf("after a write: %q", b)
	}
	if err := late(Root(), []byte("x")); err == nil {
		t.Fatal("a write after Writing returned was taken")
	}
	if names, _ := os.ReadDir(dir); len(names) != 1 {
		t.Fatalf("left beside it: %v", names)
	}
	if e := fs.Writing(Root(), filepath.Join(dir, "no", "such"), func(Push) bool { t.Fatal("use ran"); return true }); e == nil || e.Kind != 0 {
		t.Fatalf("missing directory: %v", e)
	}
}

func TestReadingAFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f.txt")
	os.WriteFile(p, []byte("a\nb\n"), 0o644)
	var all []byte
	if e := RealFS().Reading(Root(), p, func(r Pull) {
		var err error
		all, err = ReadAll(Root(), r)
		if err != nil {
			t.Fatal(err)
		}
	}); e != nil {
		t.Fatal(e)
	}
	if string(all) != "a\nb\n" {
		t.Fatalf("read %q", all)
	}
	e := RealFS().Reading(Root(), p+".missing", func(Pull) {})
	if e == nil || e.Text() != p+".missing: not found" {
		t.Fatalf("missing: %v", e)
	}
}

// Truncate cuts or pads on disk and in memory alike; Sync takes a file and a directory.
func TestTruncateAndSync(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "log")
	for _, f := range []*FS{RealFS(), MemoryFS()} {
		name := p
		if f.IsMemory() {
			name = "log"
		}
		c := Root()
		if e := f.Write(c, name, "one\ntwo\nthr"); e != nil {
			t.Fatal(e)
		}
		if e := f.Truncate(c, name, 8); e != nil {
			t.Fatal(e)
		}
		if e := f.Sync(c, name); e != nil {
			t.Fatal(e)
		}
		if got, _ := f.Read(c, name); got != "one\ntwo\n" {
			t.Fatalf("memory %v: after truncate %q", f.IsMemory(), got)
		}
		if e := f.Truncate(c, name, 10); e != nil {
			t.Fatal(e)
		}
		if got, _ := f.Read(c, name); got != "one\ntwo\n\x00\x00" {
			t.Fatalf("memory %v: after padding %q", f.IsMemory(), got)
		}
		if e := f.Truncate(c, name, -1); e == nil || e.Kind != 2 {
			t.Fatalf("memory %v: negative size gave %v", f.IsMemory(), e)
		}
		if e := f.Truncate(c, name+".missing", 0); e == nil || e.Kind != 0 {
			t.Fatalf("memory %v: missing file gave %v", f.IsMemory(), e)
		}
		if e := f.Sync(c, name+".missing"); e == nil || e.Kind != 0 {
			t.Fatalf("memory %v: sync of a missing file gave %v", f.IsMemory(), e)
		}
		d := dir
		if f.IsMemory() {
			d = "."
		}
		if e := f.Sync(c, d); e != nil {
			t.Fatalf("memory %v: sync of a directory gave %v", f.IsMemory(), e)
		}
		if e := f.Truncate(c, d, 0); e == nil || e.Kind != 2 {
			t.Fatalf("memory %v: truncating a directory gave %v", f.IsMemory(), e)
		}
	}
}
