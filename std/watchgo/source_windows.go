package watchgo

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// treeSource is one ReadDirectoryChangesW over the root and everything under it. The handle on
// the root shares delete, so the root can still be moved or removed, and there is none on the
// directories under it.
type treeSource struct {
	h    windows.Handle
	root string
	out  chan string
	errc chan error
	done chan struct{}
	// Closed when the reading goroutine has stopped, so the handle can be closed.
	stopped chan struct{}
}

func newSource(root string) (source, error) {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, err
	}
	s := &treeSource{h: h, root: root, out: make(chan string), errc: make(chan error, 1), done: make(chan struct{}), stopped: make(chan struct{})}
	go s.read()
	return s, nil
}

func (s *treeSource) read() {
	defer close(s.stopped)
	defer close(s.out)
	ev, err := windows.CreateEvent(nil, 0, 0, nil)
	if err != nil {
		s.errc <- err
		return
	}
	defer windows.CloseHandle(ev)
	// DWORD-aligned, as the call wants; 64 KB is the most it takes over a network share.
	buf := make([]uint32, 16*1024)
	const mask = windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_DIR_NAME |
		windows.FILE_NOTIFY_CHANGE_SIZE | windows.FILE_NOTIFY_CHANGE_LAST_WRITE | windows.FILE_NOTIFY_CHANGE_CREATION
	for {
		ov := windows.Overlapped{HEvent: ev}
		err := windows.ReadDirectoryChanges(s.h, (*byte)(unsafe.Pointer(&buf[0])), uint32(len(buf)*4), true, mask, nil, &ov, 0)
		if err != nil && !errors.Is(err, windows.ERROR_IO_PENDING) {
			s.fail(err)
			return
		}
		var n uint32
		if err := windows.GetOverlappedResult(s.h, &ov, &n, true); err != nil {
			if !errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
				s.fail(err)
			}
			return
		}
		if n == 0 {
			// More happened than the buffer held.
			if !s.send(overflow) {
				return
			}
			continue
		}
		for off := uint32(0); ; {
			info := (*windows.FileNotifyInformation)(unsafe.Pointer(uintptr(unsafe.Pointer(&buf[0])) + uintptr(off)))
			name := windows.UTF16ToString(unsafe.Slice(&info.FileName, info.FileNameLength/2))
			if !s.send(filepath.Join(s.root, name)) {
				return
			}
			if info.NextEntryOffset == 0 {
				break
			}
			off += info.NextEntryOffset
		}
	}
}

// fail reports err, unless the root is gone: then the watch's own check says so.
func (s *treeSource) fail(err error) {
	if _, e := os.Stat(s.root); e != nil {
		return
	}
	select {
	case s.errc <- err:
	default:
	}
}

func (s *treeSource) send(name string) bool {
	select {
	case s.out <- name:
		return true
	case <-s.done:
		return false
	}
}

// add does nothing: the root's watch covers the tree.
func (s *treeSource) add(dir string)       {}
func (s *treeSource) names() <-chan string { return s.out }
func (s *treeSource) errs() <-chan error   { return s.errc }

func (s *treeSource) close() {
	close(s.done)
	windows.CancelIoEx(s.h, nil)
	<-s.stopped
	windows.CloseHandle(s.h)
}
