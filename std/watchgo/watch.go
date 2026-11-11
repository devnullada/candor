// Package watchgo is the Go under `fs.watch`: a directory and everything under it watched,
// bursts of events on a path collapsed into one change. A watch crosses into Candor as an id in
// a table here. A program builds this package only if it calls `fs.watch`.
//
// The events come from a source: on Windows one ReadDirectoryChangesW over the whole tree, so
// the watch holds a handle on the root alone (a handle on each directory, as fsnotify keeps,
// stops it being moved or removed); elsewhere fsnotify, a watch on each directory.
package watchgo

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// A change goes out once its path has been quiet this long, or this long after the first event
// of a burst that doesn't stop.
const (
	quiet   = 100 * time.Millisecond
	longest = time.Second
)

// source is where a watch's events come from: the full paths something happened to, or
// overflow when the system dropped some.
type source interface {
	// add watches a directory under the root too, if the root's watch doesn't cover it.
	add(dir string)
	names() <-chan string
	errs() <-chan error
	close()
}

// What a source sends when events were lost: everything is looked at again.
const overflow = "\x00"

// How often a watch looks whether its root is still where it was: a directory's own move or
// removal isn't an event under it.
const rootCheck = time.Second

type watch struct {
	src  source
	root string
	// The root as it was when the watch began.
	rootInfo os.FileInfo
	// Every path under root, relative with `/`, and whether it is a directory.
	known map[string]bool
	out   chan string
	done  chan struct{}
}

var (
	mu      sync.Mutex
	watches = map[int64]*watch{}
	next    int64
)

// Start watches the directory root and every directory under it, those made later included.
func Start(root string) (int64, error) {
	info, err := os.Stat(root)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, &fs.PathError{Op: "watch", Path: root, Err: errors.New("not a directory: watch the directory it is in")}
	}
	src, err := newSource(root)
	if err != nil {
		return 0, err
	}
	wt := &watch{src: src, root: root, rootInfo: info, known: map[string]bool{}, out: make(chan string), done: make(chan struct{})}
	wt.walk("", nil)
	go wt.loop()
	mu.Lock()
	defer mu.Unlock()
	next++
	watches[next] = wt
	return next, nil
}

// Next waits for the next change: its kind ("c" created, "m" changed, "r" removed) and its path,
// "x" when root itself is gone, "e" and a message when the watcher failed, "" when ctx is
// cancelled.
func Next(ctx context.Context, id int64) string {
	mu.Lock()
	wt := watches[id]
	mu.Unlock()
	if wt == nil {
		return "eno such watch"
	}
	select {
	case s := <-wt.out:
		return s
	case <-ctx.Done():
		return ""
	}
}

// Stop ends the watch.
func Stop(id int64) {
	mu.Lock()
	wt := watches[id]
	delete(watches, id)
	mu.Unlock()
	if wt != nil {
		close(wt.done)
		wt.src.close()
	}
}

// walk adds the directory rel and everything under it to what's known, watching each
// directory; with created, it notes each path that wasn't known before.
func (wt *watch) walk(rel string, created *[]string) {
	entries, err := os.ReadDir(wt.full(rel))
	if err != nil {
		return
	}
	for _, e := range entries {
		r := e.Name()
		if rel != "" {
			r = rel + "/" + r
		}
		if _, ok := wt.known[r]; !ok && created != nil {
			*created = append(*created, r)
		}
		wt.known[r] = e.IsDir()
		if e.IsDir() {
			wt.src.add(wt.full(r))
			wt.walk(r, created)
		}
	}
}

func (wt *watch) full(rel string) string {
	if rel == "" {
		return wt.root
	}
	return filepath.Join(wt.root, filepath.FromSlash(rel))
}

func (wt *watch) rel(name string) string {
	r, err := filepath.Rel(wt.root, name)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(r)
}

// onDisk adds every path under the directory rel, as it is now, to paths.
func (wt *watch) onDisk(rel string, paths map[string]bool) {
	entries, _ := os.ReadDir(wt.full(rel))
	for _, e := range entries {
		r := e.Name()
		if rel != "" {
			r = rel + "/" + r
		}
		paths[r] = true
		if e.IsDir() {
			wt.onDisk(r, paths)
		}
	}
}

// rootThere is whether the root is still the directory the watch began on.
func (wt *watch) rootThere() bool {
	info, err := os.Stat(wt.root)
	return err == nil && os.SameFile(info, wt.rootInfo)
}

func (wt *watch) loop() {
	tick := time.NewTicker(rootCheck)
	defer tick.Stop()
	pending := map[string]bool{}
	var timer *time.Timer
	var fire <-chan time.Time
	var first time.Time
	names, errs := wt.src.names(), wt.src.errs()
	for {
		select {
		case name, ok := <-names:
			if !ok {
				// The source is done (its root gone, say): what's pending still settles.
				names = nil
				continue
			}
			if name == overflow {
				for k := range wt.known {
					pending[k] = true
				}
				wt.onDisk("", pending)
			} else {
				pending[wt.rel(name)] = true
			}
			if timer == nil {
				first = time.Now()
				timer = time.NewTimer(quiet)
				fire = timer.C
			} else {
				timer.Reset(min(quiet, max(0, longest-time.Since(first))))
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			if !wt.send("e" + err.Error()) {
				return
			}
		case <-tick.C:
			if !wt.rootThere() {
				wt.send("x")
				return
			}
		case <-fire:
			timer, fire = nil, nil
			changes := wt.settle(pending)
			pending = map[string]bool{}
			for _, c := range changes {
				if !wt.send(c) {
					return
				}
			}
		case <-wt.done:
			return
		}
	}
}

func (wt *watch) send(s string) bool {
	select {
	case wt.out <- s:
		return true
	case <-wt.done:
		return false
	}
}

// settle turns the paths events named into changes, by what is there now against what was
// known: a burst that made and removed a file is nothing, one that wrote it three times is one
// change.
func (wt *watch) settle(pending map[string]bool) []string {
	if !wt.rootThere() {
		return []string{"x"}
	}
	paths := make([]string, 0, len(pending))
	for p := range pending {
		if p != "" && p != "." && !strings.HasPrefix(p, "../") {
			paths = append(paths, p)
		}
	}
	slices.Sort(paths)
	var out []string
	// Paths a new directory's walk already gave as created.
	given := map[string]bool{}
	created := func(dir string) {
		wt.src.add(wt.full(dir))
		var found []string
		wt.walk(dir, &found)
		for _, k := range found {
			given[k] = true
			out = append(out, "c"+k)
		}
	}
	// What was under a directory goes first, deepest first.
	removed := func(p string) {
		var under []string
		for k := range wt.known {
			if strings.HasPrefix(k, p+"/") {
				under = append(under, k)
			}
		}
		slices.Sort(under)
		slices.Reverse(under)
		for _, k := range under {
			delete(wt.known, k)
			out = append(out, "r"+k)
		}
		delete(wt.known, p)
		out = append(out, "r"+p)
	}
	for _, p := range paths {
		if given[p] {
			continue
		}
		wasDir, known := wt.known[p]
		info, err := os.Stat(wt.full(p))
		switch {
		case err != nil && known:
			removed(p)
		case err != nil:
		case !known:
			wt.known[p] = info.IsDir()
			out = append(out, "c"+p)
			if info.IsDir() {
				created(p)
			}
		case wasDir != info.IsDir():
			// Replaced by the other kind: a file where a directory was, or the reverse.
			removed(p)
			wt.known[p] = info.IsDir()
			out = append(out, "c"+p)
			if info.IsDir() {
				created(p)
			}
		case !info.IsDir():
			out = append(out, "m"+p)
		}
	}
	return out
}
