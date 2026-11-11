// Package imapgo is the Go under std/imap.candor: an IMAP session over implicit TLS, on
// github.com/emersion/go-imap v1. A session crosses into Candor as an id in a table here, and
// what it gives back as flat lists of strings, since bindings pass ints, strings and lists.
package imapgo

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
)

// The kinds of failure std/imap.candor tells apart (`Kind`).
const (
	kindConnect = iota
	kindLogin
	kindTimeout
	kindNoFolder
	kindFailed
)

type kindError struct {
	kind int
	err  error
}

func (e *kindError) Error() string { return e.err.Error() }

// failed is err as a failure of kind when the server refused (go-imap gives a NO or BAD as a
// plain error); a timeout, or a connection that broke, says so instead.
func failed(kind int, err error) error {
	var ne net.Error
	switch {
	case errors.As(err, &ne) && ne.Timeout():
		kind = kindTimeout
	case errors.As(err, &ne), errors.Is(err, io.EOF), strings.Contains(err.Error(), "connection closed"):
		kind = kindConnect
	}
	return &kindError{kind: kind, err: err}
}

// Kind is the kind of a failure from this package.
func Kind(err error) int64 {
	var k *kindError
	if errors.As(err, &k) {
		return int64(k.kind)
	}
	return kindFailed
}

// roots is who signs a server's certificate; nil for the system's. Only this package's tests
// change it, for their own server.
var roots *x509.CertPool

var (
	mu       sync.Mutex
	sessions = map[int64]*client.Client{}
	nextID   int64
)

func session(id int64) (*client.Client, error) {
	mu.Lock()
	defer mu.Unlock()
	c, ok := sessions[id]
	if !ok {
		return nil, &kindError{kind: kindFailed, err: errors.New("the session has ended")}
	}
	return c, nil
}

// whileOpen ends the connection if ctx is cancelled during f: the task using it was.
func whileOpen(ctx context.Context, c *client.Client, f func() error) error {
	stop := context.AfterFunc(ctx, func() { c.Terminate() })
	defer stop()
	err := f()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// Open connects to host:port over TLS and logs in: a session id. timeoutMs bounds the connect
// and then every command.
func Open(ctx context.Context, host string, port int64, user, password string, timeoutMs int64) (int64, error) {
	if timeoutMs <= 0 {
		return 0, &kindError{kind: kindFailed, err: fmt.Errorf("timeoutMs is %d: give it a positive number of milliseconds", timeoutMs)}
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	addr := net.JoinHostPort(host, strconv.FormatInt(port, 10))
	dialer := &net.Dialer{Timeout: timeout}
	c, err := client.DialWithDialerTLS(dialer, addr, &tls.Config{ServerName: host, RootCAs: roots})
	if err != nil {
		return 0, failed(kindConnect, err)
	}
	c.Timeout = timeout
	if err := whileOpen(ctx, c, func() error { return c.Login(user, password) }); err != nil {
		c.Terminate()
		if ctx.Err() != nil {
			return 0, err
		}
		return 0, failed(kindLogin, err)
	}
	mu.Lock()
	nextID++
	id := nextID
	sessions[id] = c
	mu.Unlock()
	return id, nil
}

// Folders lists every folder: for each its name, its hierarchy delimiter, then its attributes
// joined with spaces (`\HasNoChildren \Sent`).
func Folders(ctx context.Context, id int64) ([]string, error) {
	c, err := session(id)
	if err != nil {
		return nil, err
	}
	var out []string
	err = whileOpen(ctx, c, func() error {
		ch := make(chan *imap.MailboxInfo, 16)
		done := make(chan error, 1)
		go func() { done <- c.List("", "*", ch) }()
		for info := range ch {
			out = append(out, info.Name, info.Delimiter, strings.Join(info.Attributes, " "))
		}
		return <-done
	})
	if err != nil {
		return nil, failed(kindFailed, err)
	}
	return out, nil
}

// Select opens folder read-only (EXAMINE, so nothing is marked): its uidValidity, message
// count and next UID.
func Select(ctx context.Context, id int64, folder string) ([]string, error) {
	c, err := session(id)
	if err != nil {
		return nil, err
	}
	var box *imap.MailboxStatus
	err = whileOpen(ctx, c, func() error {
		var err error
		box, err = c.Select(folder, true)
		return err
	})
	if err != nil {
		return nil, failed(kindNoFolder, err)
	}
	u := func(n uint32) string { return strconv.FormatUint(uint64(n), 10) }
	return []string{u(box.UidValidity), u(box.Messages), u(box.UidNext)}, nil
}

// Fetch reads the messages from..to (to 0 is the last) of the selected folder: by sequence
// number, or by UID when byUID. For each: its UID, its internal date in ms, its raw source.
// The source is read with BODY.PEEK[], so a message isn't marked seen.
func Fetch(ctx context.Context, id int64, from, to int64, byUID bool) ([]string, error) {
	c, err := session(id)
	if err != nil {
		return nil, err
	}
	if c.Mailbox() == nil {
		return nil, &kindError{kind: kindFailed, err: errors.New("no folder is selected: call imap.select first")}
	}
	set := new(imap.SeqSet)
	set.AddRange(uint32(from), uint32(to))
	section := &imap.BodySectionName{Peek: true}
	items := []imap.FetchItem{imap.FetchUid, imap.FetchInternalDate, section.FetchItem()}
	var out []string
	err = whileOpen(ctx, c, func() error {
		ch := make(chan *imap.Message, 16)
		done := make(chan error, 1)
		go func() {
			if byUID {
				done <- c.UidFetch(set, items, ch)
			} else {
				done <- c.Fetch(set, items, ch)
			}
		}()
		var readErr error
		for msg := range ch {
			body := msg.GetBody(section)
			if body == nil {
				continue
			}
			raw, err := io.ReadAll(body)
			if err != nil && readErr == nil {
				readErr = err
			}
			out = append(out, strconv.FormatUint(uint64(msg.Uid), 10), strconv.FormatInt(msg.InternalDate.UnixMilli(), 10), string(raw))
		}
		if err := <-done; err != nil {
			return err
		}
		return readErr
	})
	if err != nil {
		return nil, failed(kindFailed, err)
	}
	return out, nil
}

// Close logs out and ends the session; a session already gone is fine.
func Close(id int64) {
	mu.Lock()
	c, ok := sessions[id]
	delete(sessions, id)
	mu.Unlock()
	if !ok {
		return
	}
	if c.Logout() != nil {
		c.Terminate()
	}
}
