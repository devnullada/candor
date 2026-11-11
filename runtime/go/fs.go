package candor

import (
	"bufio"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
)

// FS is the `fs` effect: the files on disk for `main`, or, in a test, a file system in memory
// that starts empty but for the current directory. Paths are as given, relative to the working
// directory or absolute.
type FS struct {
	mem *memFS
}

// RealFS is the `fs` effect `main` gets.
func RealFS() *FS { return &FS{} }

// MemoryFS is the `fs` effect a test gets: empty, fresh for every test.
func MemoryFS() *FS {
	return &FS{mem: &memFS{files: map[string]string{}, dirs: map[string]bool{".": true, "/": true}, modified: map[string]int64{}}}
}

// FsErr is why an operation failed, for `fs.FsError`: Kind 0 is NotFound, 1 Denied, 2 Failed.
type FsErr struct {
	Kind    int64
	Path    string
	Message string
}

func fsErr(p string, err error) *FsErr {
	var pe *fs.PathError
	var le *os.LinkError
	msg := err.Error()
	if errors.As(err, &pe) {
		msg = pe.Err.Error()
	} else if errors.As(err, &le) {
		msg = le.Err.Error()
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return &FsErr{0, p, msg}
	case errors.Is(err, fs.ErrPermission):
		return &FsErr{1, p, msg}
	}
	return &FsErr{2, p, msg}
}

func (f *FS) Read(c *Ctx, p string) (string, *FsErr) {
	c.point()
	if f.mem != nil {
		return f.mem.read(p)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", fsErr(p, err)
	}
	return string(b), nil
}

// ReadRange is up to n bytes from offset off: fewer at the end of the file, none past it. A
// negative off or n counts as 0.
func (f *FS) ReadRange(c *Ctx, p string, off, n int64) ([]byte, *FsErr) {
	c.point()
	off, n = max(off, 0), max(n, 0)
	if f.mem != nil {
		text, e := f.mem.read(p)
		if e != nil {
			return nil, e
		}
		size := int64(len(text))
		start := min(off, size)
		return []byte(text[start:min(start+min(n, size-start), size)]), nil
	}
	src, err := os.Open(p)
	if err != nil {
		return nil, fsErr(p, err)
	}
	defer src.Close()
	st, err := src.Stat()
	if err != nil {
		return nil, fsErr(p, err)
	}
	if st.IsDir() {
		return nil, &FsErr{2, p, errIsDir.Error()}
	}
	if off >= st.Size() {
		return []byte{}, nil
	}
	buf := make([]byte, min(n, st.Size()-off))
	got, err := src.ReadAt(buf, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fsErr(p, err)
	}
	return buf[:got:got], nil
}

// IsMemory says whether f is a test's file system, which the server can't send from.
func (f *FS) IsMemory() bool { return f.mem != nil }

// ReadBytes is the whole file, as it is.
func (f *FS) ReadBytes(c *Ctx, p string) ([]byte, *FsErr) {
	c.point()
	if f.mem != nil {
		text, e := f.mem.read(p)
		return []byte(text), e
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, fsErr(p, err)
	}
	return b, nil
}

// WriteBytes is Write, with bytes: the memory keeps them in a string as Go does any.
func (f *FS) WriteBytes(c *Ctx, p string, b []byte) *FsErr { return f.Write(c, p, string(b)) }

// Write replaces the file's text, making the file if missing (not its directory).
func (f *FS) Write(c *Ctx, p, text string) *FsErr {
	c.point()
	if f.mem != nil {
		return f.mem.write(c, p, text, false)
	}
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		return fsErr(p, err)
	}
	return nil
}

func (f *FS) Append(c *Ctx, p, text string) *FsErr {
	c.point()
	if f.mem != nil {
		return f.mem.write(c, p, text, true)
	}
	file, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fsErr(p, err)
	}
	_, err = file.WriteString(text)
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fsErr(p, err)
	}
	return nil
}

// Sync flushes a file, or a directory's entries, to the disk. Windows can't sync a directory,
// so there one is only checked.
func (f *FS) Sync(c *Ctx, p string) *FsErr {
	c.point()
	if f.mem != nil {
		if !f.mem.exists(p) {
			return &FsErr{0, p, errNotFound.Error()}
		}
		return nil
	}
	st, err := os.Stat(p)
	if err != nil {
		return fsErr(p, err)
	}
	if st.IsDir() && runtime.GOOS == "windows" {
		return nil
	}
	flag := os.O_RDONLY
	if !st.IsDir() && runtime.GOOS == "windows" {
		// Windows flushes only a handle opened for writing.
		flag = os.O_WRONLY
	}
	file, err := os.OpenFile(p, flag, 0)
	if err != nil {
		return fsErr(p, err)
	}
	err = file.Sync()
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fsErr(p, err)
	}
	return nil
}

// Truncate cuts p to size bytes, or pads it with zeros; p must exist.
func (f *FS) Truncate(c *Ctx, p string, size int64) *FsErr {
	c.point()
	if size < 0 {
		return &FsErr{2, p, errInvalid.Error()}
	}
	if f.mem != nil {
		return f.mem.truncate(c, p, size)
	}
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		return &FsErr{2, p, errIsDir.Error()}
	}
	if err := os.Truncate(p, size); err != nil {
		return fsErr(p, err)
	}
	return nil
}

func (f *FS) Exists(c *Ctx, p string) bool {
	c.point()
	if f.mem != nil {
		return f.mem.exists(p)
	}
	_, err := os.Stat(p)
	return err == nil
}

// Remove removes a file, or a directory that is empty.
func (f *FS) Remove(c *Ctx, p string) *FsErr {
	c.point()
	if f.mem != nil {
		return f.mem.remove(c, p)
	}
	if err := os.Remove(p); err != nil {
		return fsErr(p, err)
	}
	return nil
}

// List gives the names in a directory, sorted.
func (f *FS) List(c *Ctx, p string) ([]string, *FsErr) {
	c.point()
	if f.mem != nil {
		return f.mem.list(p)
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, fsErr(p, err)
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names, nil
}

// MakeDir makes the directory and any missing above it; one already there is fine.
func (f *FS) MakeDir(c *Ctx, p string) *FsErr {
	c.point()
	if f.mem != nil {
		return f.mem.makeDir(c, p)
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		return fsErr(p, err)
	}
	return nil
}

// ReadLines calls each with every line of the file, without its line ending (`\n` or `\r\n`),
// reading a piece at a time.
func (f *FS) ReadLines(c *Ctx, p string, each func(*Ctx, string)) *FsErr {
	c.point()
	if f.mem != nil {
		text, e := f.mem.read(p)
		if e != nil {
			return e
		}
		for _, line := range Lines(text) {
			each(c, line)
		}
		return nil
	}
	file, err := os.Open(p)
	if err != nil {
		return fsErr(p, err)
	}
	defer file.Close()
	sc := bufio.NewScanner(file)
	sc.Buffer(make([]byte, 64*1024), 1<<30)
	for sc.Scan() {
		each(c, strings.TrimSuffix(sc.Text(), "\r"))
	}
	if err := sc.Err(); err != nil {
		return fsErr(p, err)
	}
	return nil
}

// Text is the error as `FsError`'s Show writes it, for a reader's or writer's error.
func (e *FsErr) Text() string {
	switch e.Kind {
	case 0:
		return e.Path + ": not found"
	case 1:
		return e.Path + ": permission denied"
	}
	return e.Path + ": " + e.Message
}

// Reading opens p and gives use a reader over it, closing the file when use returns
// or a cancel unwinds it. A cancel also closes the file under a read that is waiting.
func (f *FS) Reading(c *Ctx, p string, use func(r Pull)) *FsErr {
	c.point()
	if f.mem != nil {
		text, e := f.mem.read(p)
		if e != nil {
			return e
		}
		pull := PullBytes([]byte(text))
		use(func(c *Ctx, n int64) ([]byte, bool, error) {
			c.point()
			return pull(c, n)
		})
		return nil
	}
	file, err := os.Open(p)
	if err != nil {
		return fsErr(p, err)
	}
	if st, err := file.Stat(); err != nil || st.IsDir() {
		file.Close()
		if err != nil {
			return fsErr(p, err)
		}
		return &FsErr{2, p, errIsDir.Error()}
	}
	var done atomic.Bool
	stop := context.AfterFunc(c.Context(), func() { file.Close() })
	defer func() {
		done.Store(true)
		stop()
		file.Close()
	}()
	use(func(c *Ctx, n int64) ([]byte, bool, error) {
		c.point()
		if done.Load() {
			return nil, false, StreamErr(p + ": read after fs.reading returned")
		}
		buf := make([]byte, pullN(n))
		for {
			k, err := file.Read(buf)
			if k > 0 {
				return buf[:k:k], true, nil
			}
			if errors.Is(err, io.EOF) {
				return nil, false, nil
			}
			if err != nil {
				c.Check()
				return nil, false, StreamErr(fsErr(p, err).Text())
			}
		}
	})
	return nil
}

// Writing gives use a writer into a new file beside p, which replaces p once use says it
// succeeded (synced first), and is removed otherwise, a cancel included: p is never left half
// written.
func (f *FS) Writing(c *Ctx, p string, use func(w Push) bool) *FsErr {
	c.point()
	var done atomic.Bool
	late := StreamErr(p + ": written after fs.writing returned")
	if f.mem != nil {
		if e := f.mem.writable(p); e != nil {
			return e
		}
		var mu sync.Mutex
		buf := []byte{}
		ok := use(func(c *Ctx, b []byte) error {
			c.point()
			mu.Lock()
			defer mu.Unlock()
			if done.Load() {
				return late
			}
			buf = append(buf, b...)
			return nil
		})
		mu.Lock()
		done.Store(true)
		mu.Unlock()
		if !ok {
			return nil
		}
		return f.mem.write(c, p, string(buf), false)
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(p); err == nil {
		if st.IsDir() {
			return &FsErr{2, p, errIsDir.Error()}
		}
		mode = st.Mode().Perm()
	}
	dir, base := filepath.Split(p)
	if dir == "" {
		dir = "."
	}
	tmp, err := os.CreateTemp(dir, "."+base+".*.tmp")
	if err != nil {
		return fsErr(p, err)
	}
	kept := false
	defer func() {
		done.Store(true)
		if !kept {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	ok := use(func(c *Ctx, b []byte) error {
		c.point()
		if done.Load() {
			return late
		}
		if _, err := tmp.Write(b); err != nil {
			return StreamErr(fsErr(p, err).Text())
		}
		return nil
	})
	done.Store(true)
	if !ok {
		return nil
	}
	if err := tmp.Chmod(mode); err != nil {
		return fsErr(p, err)
	}
	if err := tmp.Sync(); err != nil {
		return fsErr(p, err)
	}
	if err := tmp.Close(); err != nil {
		return fsErr(p, err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return fsErr(p, err)
	}
	kept = true
	// The rename itself survives a crash once the directory is synced. Some file systems
	// refuse it; the file is in place either way.
	if runtime.GOOS != "windows" {
		if d, err := os.Open(dir); err == nil {
			d.Sync()
			d.Close()
		}
	}
	return nil
}

// Within is `root` joined with `p`, or false if `p` is absolute or climbs out of `root` with
// `..`. By the text alone: `\` counts as `/`, and a `:` anywhere (a drive, a Windows stream) is
// refused, so the answer is the same on every system and in the fake.
func Within(root, p string) (string, bool) {
	p = strings.ReplaceAll(p, `\`, "/")
	if strings.HasPrefix(p, "/") || strings.Contains(p, ":") || strings.Contains(p, "\x00") {
		return "", false
	}
	rel := path.Clean(p)
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return path.Join(root, rel), true
}

// Join is p after root, cleaned, with root's separator: `\` if root has one and no `/`, else
// `/`.
func Join(root, p string) string {
	sep := "/"
	if strings.Contains(root, `\`) && !strings.Contains(root, "/") {
		sep = `\`
	}
	slashed := strings.ReplaceAll(root, `\`, "/")
	// A drive (`D:`) or a share (`//nas/share`) is a volume: `..` stops at its root, and
	// `D:` alone, the current directory on D:, never stands for `D:\`.
	vol := ""
	if len(slashed) >= 2 && slashed[1] == ':' && ('a' <= slashed[0]|0x20 && slashed[0]|0x20 <= 'z') {
		vol, slashed = slashed[:2], slashed[2:]
	} else if rest, ok := strings.CutPrefix(slashed, "//"); ok {
		parts := strings.SplitN(rest, "/", 3)
		if len(parts) >= 2 {
			vol, slashed = "//"+parts[0]+"/"+parts[1], "/"
			if len(parts) == 3 {
				slashed += parts[2]
			}
		}
	}
	j := vol + path.Join(slashed, strings.ReplaceAll(p, `\`, "/"))
	return strings.ReplaceAll(j, "/", sep)
}

// FileInfo is what `fs.info` tells: a directory's size is 0, `Modified` is in milliseconds.
type FileInfo struct {
	Size     int64
	Modified int64
	IsDir    bool
}

func (f *FS) Info(c *Ctx, p string) (FileInfo, *FsErr) {
	c.point()
	if f.mem != nil {
		return f.mem.info(p)
	}
	st, err := os.Stat(p)
	if err != nil {
		return FileInfo{}, fsErr(p, err)
	}
	info := FileInfo{Size: st.Size(), Modified: st.ModTime().UnixMilli(), IsDir: st.IsDir()}
	if info.IsDir {
		info.Size = 0
	}
	return info, nil
}

// Rename moves a file or a directory, replacing a file already at `to`. Errors name `from`.
func (f *FS) Rename(c *Ctx, from, to string) *FsErr {
	c.point()
	if f.mem != nil {
		return f.mem.rename(c, from, to)
	}
	if err := os.Rename(from, to); err != nil {
		return fsErr(from, err)
	}
	return nil
}

// Copy copies a file's bytes a piece at a time, replacing a file already at `to`.
func (f *FS) Copy(c *Ctx, from, to string) *FsErr {
	c.point()
	if f.mem != nil {
		text, e := f.mem.read(from)
		if e != nil {
			return e
		}
		return f.mem.write(c, to, text, false)
	}
	src, err := os.Open(from)
	if err != nil {
		return fsErr(from, err)
	}
	defer src.Close()
	if st, err := src.Stat(); err != nil {
		return fsErr(from, err)
	} else if st.IsDir() {
		return &FsErr{2, from, errIsDir.Error()}
	}
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fsErr(to, err)
	}
	_, err = io.Copy(dst, src)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fsErr(to, err)
	}
	return nil
}

// RemoveAll removes a file, or a directory and everything in it; nothing there is fine. It
// refuses a root (`/`, `C:\`) and the working directory or above it (`.`, `..`).
func (f *FS) RemoveAll(c *Ctx, p string) *FsErr {
	c.point()
	if isRoot(p) {
		return &FsErr{2, p, "refusing to remove a root or the working directory"}
	}
	if f.mem != nil {
		f.mem.removeAll(c, p)
		return nil
	}
	if err := os.RemoveAll(p); err != nil {
		return fsErr(p, err)
	}
	return nil
}

func isRoot(p string) bool {
	k := clean(p)
	if len(k) >= 2 && k[1] == ':' {
		k = k[2:]
	}
	return k == "" || k == "." || k == "/" || k == ".." || strings.HasPrefix(k, "../") && strings.Trim(k, "./") == ""
}

// memFS is a test's file system: files and directories by cleaned path, and when each was
// last written (the test's virtual time).
type memFS struct {
	mu       sync.Mutex
	files    map[string]string
	dirs     map[string]bool
	modified map[string]int64
	// The test's `fs.watch`es, in the order they began, so waking them replays by the seed.
	watches []*memWatch
	watchID int64
}

// memWatch is a test's `fs.watch`: the changes made under root since it began, each as
// watchgo's Next gives one, and the tasks waiting for the next.
type memWatch struct {
	id      int64
	root    string
	queue   []string
	waiting []*simTask
}

// changed tells every watch over k that it was created ('c'), changed ('m') or removed ('r').
// Each write is its own change: a test's writes are deliberate, so nothing is collapsed.
func (m *memFS) changed(c *Ctx, kind byte, k string) {
	for _, w := range m.watches {
		var s string
		if k == w.root {
			if kind != 'r' {
				continue
			}
			s = "x"
		} else if rel, ok := relUnder(w.root, k); ok {
			s = string(kind) + rel
		} else {
			continue
		}
		w.queue = append(w.queue, s)
		if c.sim != nil {
			c.sim.wakeAll(&w.waiting)
		}
	}
}

// relUnder is k relative to the directory root, if k is under it; both are cleaned.
func relUnder(root, k string) (string, bool) {
	switch root {
	case ".":
		if strings.HasPrefix(k, "/") || k == ".." || strings.HasPrefix(k, "../") {
			return "", false
		}
		return k, true
	case "/":
		return strings.TrimPrefix(k, "/"), strings.HasPrefix(k, "/") && k != "/"
	}
	return strings.CutPrefix(k, root+"/")
}

// changedAll tells the watches about each of ks, deepest first when removing.
func (m *memFS) changedAll(c *Ctx, kind byte, ks []string) {
	slices.Sort(ks)
	if kind == 'r' {
		slices.Reverse(ks)
	}
	for _, k := range ks {
		m.changed(c, kind, k)
	}
}

// StartWatch begins a test's `fs.watch` of the directory p: the changes made under it from now
// on. (`main`'s watch is std/watchgo's.)
func (f *FS) StartWatch(c *Ctx, p string) (int64, *FsErr) {
	c.point()
	m := f.mem
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if !m.dirs[k] {
		if _, ok := m.files[k]; ok {
			return 0, &FsErr{2, p, "not a directory: watch the directory it is in"}
		}
		return 0, &FsErr{0, p, errNotFound.Error()}
	}
	m.watchID++
	m.watches = append(m.watches, &memWatch{id: m.watchID, root: k})
	return m.watchID, nil
}

// NextChange waits for the watch's next change, as watchgo's Next gives it.
func (f *FS) NextChange(c *Ctx, id int64) string {
	c.point()
	m := f.mem
	for {
		m.mu.Lock()
		i := slices.IndexFunc(m.watches, func(w *memWatch) bool { return w.id == id })
		if i < 0 {
			m.mu.Unlock()
			return "eno such watch"
		}
		w := m.watches[i]
		if len(w.queue) > 0 {
			s := w.queue[0]
			w.queue = w.queue[1:]
			m.mu.Unlock()
			return s
		}
		m.mu.Unlock()
		c.sim.waitIn(&w.waiting, c.st, c.tok, "fs.watch")
		c.Check()
	}
}

// StopWatch ends a test's watch.
func (f *FS) StopWatch(id int64) {
	m := f.mem
	m.mu.Lock()
	defer m.mu.Unlock()
	m.watches = slices.DeleteFunc(m.watches, func(w *memWatch) bool { return w.id == id })
}

// FsErrOf is err, from operating on p, as an FsError's parts.
func FsErrOf(p string, err error) *FsErr { return fsErr(p, err) }

func memNow(c *Ctx) int64 {
	if c.sim == nil {
		return 0
	}
	return c.sim.now
}

func clean(p string) string { return path.Clean(strings.ReplaceAll(p, `\`, "/")) }

var (
	errNotFound = errors.New("no such file or directory")
	errIsDir    = errors.New("is a directory")
	errNotDir   = errors.New("not a directory")
	errNotEmpty = errors.New("directory not empty")
	errExists   = errors.New("file exists")
	errInvalid  = errors.New("invalid argument")
)

func (m *memFS) read(p string) (string, *FsErr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if text, ok := m.files[k]; ok {
		return text, nil
	}
	if m.dirs[k] {
		return "", &FsErr{2, p, errIsDir.Error()}
	}
	return "", &FsErr{0, p, errNotFound.Error()}
}

// writable says why p can't be written, or nil.
func (m *memFS) writable(p string) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writableLocked(p)
}

func (m *memFS) writableLocked(p string) *FsErr {
	k := clean(p)
	if m.dirs[k] {
		return &FsErr{2, p, errIsDir.Error()}
	}
	if !m.dirs[path.Dir(k)] {
		return &FsErr{0, p, errNotFound.Error()}
	}
	return nil
}

func (m *memFS) write(c *Ctx, p, text string, appending bool) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if e := m.writableLocked(p); e != nil {
		return e
	}
	if appending {
		text = m.files[k] + text
	}
	_, existed := m.files[k]
	m.files[k] = text
	m.modified[k] = memNow(c)
	m.changed(c, map[bool]byte{true: 'm', false: 'c'}[existed], k)
	return nil
}

func (m *memFS) truncate(c *Ctx, p string, size int64) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	text, ok := m.files[k]
	if !ok {
		if m.dirs[k] {
			return &FsErr{2, p, errIsDir.Error()}
		}
		return &FsErr{0, p, errNotFound.Error()}
	}
	if int64(len(text)) >= size {
		text = text[:size]
	} else {
		text += strings.Repeat("\x00", int(size)-len(text))
	}
	m.files[k] = text
	m.modified[k] = memNow(c)
	m.changed(c, 'm', k)
	return nil
}

func (m *memFS) info(p string) (FileInfo, *FsErr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if text, ok := m.files[k]; ok {
		return FileInfo{Size: int64(len(text)), Modified: m.modified[k]}, nil
	}
	if m.dirs[k] {
		return FileInfo{Modified: m.modified[k], IsDir: true}, nil
	}
	return FileInfo{}, &FsErr{0, p, errNotFound.Error()}
}

// rename moves `from` and, for a directory, everything under it.
func (m *memFS) rename(c *Ctx, from, to string) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, dst := clean(from), clean(to)
	_, isFile := m.files[src]
	if !isFile && !m.dirs[src] {
		return &FsErr{0, from, errNotFound.Error()}
	}
	if src == dst {
		return nil
	}
	if !m.dirs[path.Dir(dst)] {
		return &FsErr{0, from, errNotFound.Error()}
	}
	if m.dirs[dst] {
		return &FsErr{2, from, errExists.Error()}
	}
	if isFile {
		_, replaced := m.files[dst]
		m.files[dst], m.modified[dst] = m.files[src], memNow(c)
		delete(m.files, src)
		delete(m.modified, src)
		m.changed(c, 'r', src)
		m.changed(c, map[bool]byte{true: 'm', false: 'c'}[replaced], dst)
		return nil
	}
	if strings.HasPrefix(dst, src+"/") {
		return &FsErr{2, from, errInvalid.Error()}
	}
	if _, ok := m.files[dst]; ok {
		return &FsErr{2, from, errExists.Error()}
	}
	moved := func(k string) (string, bool) {
		if k == src {
			return dst, true
		}
		if rest, ok := strings.CutPrefix(k, src+"/"); ok {
			return dst + "/" + rest, true
		}
		return "", false
	}
	var gone, made []string
	for k, text := range m.files {
		if n, ok := moved(k); ok {
			m.files[n], m.modified[n] = text, m.modified[k]
			delete(m.files, k)
			delete(m.modified, k)
			gone, made = append(gone, k), append(made, n)
		}
	}
	for k := range m.dirs {
		if n, ok := moved(k); ok {
			m.dirs[n], m.modified[n] = true, m.modified[k]
			delete(m.dirs, k)
			delete(m.modified, k)
			gone, made = append(gone, k), append(made, n)
		}
	}
	m.changedAll(c, 'r', gone)
	m.changedAll(c, 'c', made)
	return nil
}

func (m *memFS) removeAll(c *Ctx, p string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	under := func(x string) bool { return x == k || strings.HasPrefix(x, k+"/") }
	var gone []string
	for x := range m.files {
		if under(x) {
			delete(m.files, x)
			delete(m.modified, x)
			gone = append(gone, x)
		}
	}
	for x := range m.dirs {
		if under(x) {
			delete(m.dirs, x)
			delete(m.modified, x)
			gone = append(gone, x)
		}
	}
	m.changedAll(c, 'r', gone)
}

func (m *memFS) exists(p string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	_, file := m.files[k]
	return file || m.dirs[k]
}

func (m *memFS) remove(c *Ctx, p string) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if _, ok := m.files[k]; ok {
		delete(m.files, k)
		m.changed(c, 'r', k)
		return nil
	}
	if !m.dirs[k] {
		return &FsErr{0, p, errNotFound.Error()}
	}
	if len(m.children(k)) > 0 {
		return &FsErr{2, p, errNotEmpty.Error()}
	}
	delete(m.dirs, k)
	m.changed(c, 'r', k)
	return nil
}

func (m *memFS) list(p string) ([]string, *FsErr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	if !m.dirs[k] {
		if _, ok := m.files[k]; ok {
			return nil, &FsErr{2, p, errNotDir.Error()}
		}
		return nil, &FsErr{0, p, errNotFound.Error()}
	}
	return m.children(k), nil
}

// children are the names directly inside dir, sorted.
func (m *memFS) children(dir string) []string {
	var names []string
	add := func(k string) {
		if k != dir && path.Dir(k) == dir {
			names = append(names, path.Base(k))
		}
	}
	for k := range m.files {
		add(k)
	}
	for k := range m.dirs {
		add(k)
	}
	slices.Sort(names)
	return names
}

func (m *memFS) makeDir(c *Ctx, p string) *FsErr {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := clean(p)
	var missing []string
	for d := k; !m.dirs[d]; d = path.Dir(d) {
		if _, ok := m.files[d]; ok {
			return &FsErr{2, p, errNotDir.Error()}
		}
		missing = append(missing, d)
	}
	for _, d := range missing {
		m.dirs[d] = true
		m.modified[d] = memNow(c)
	}
	m.changedAll(c, 'c', missing)
	return nil
}
