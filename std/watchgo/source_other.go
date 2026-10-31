//go:build !windows

package watchgo

import "github.com/fsnotify/fsnotify"

// fsnotifySource watches each directory on its own, as inotify and kqueue do.
type fsnotifySource struct {
	w   *fsnotify.Watcher
	out chan string
}

func newSource(root string) (source, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := w.Add(root); err != nil {
		w.Close()
		return nil, err
	}
	s := &fsnotifySource{w: w, out: make(chan string)}
	go func() {
		defer close(s.out)
		for ev := range w.Events {
			// A permission or time change alone is noise to a watcher of contents.
			if ev.Op == fsnotify.Chmod {
				continue
			}
			s.out <- ev.Name
		}
	}()
	return s, nil
}

func (s *fsnotifySource) add(dir string)       { s.w.Add(dir) }
func (s *fsnotifySource) names() <-chan string { return s.out }
func (s *fsnotifySource) errs() <-chan error   { return s.w.Errors }

func (s *fsnotifySource) close() {
	s.w.Close()
	// The forwarding goroutine may be holding an event nobody takes now.
	for range s.out {
	}
}
