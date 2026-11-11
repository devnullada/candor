// Package smtpgo is the Go under std/smtp.candor: mail submission over Go's net/smtp, on port
// 465 with implicit TLS or any other port with STARTTLS (required, never plain), AUTH PLAIN or
// LOGIN.
package smtpgo

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// The kinds of failure std/smtp.candor tells apart (`Kind`).
const (
	kindConnect = iota
	kindLogin
	kindRecipient
	kindTimeout
	kindFailed
)

type kindError struct {
	kind int
	err  error
}

func (e *kindError) Error() string { return e.err.Error() }

// failed is err as a failure of kind; a timeout, or a connection that broke, says so instead.
func failed(kind int, err error) error {
	var ne net.Error
	switch {
	case errors.As(err, &ne) && ne.Timeout():
		kind = kindTimeout
	case errors.As(err, &ne), errors.Is(err, io.EOF):
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

// implicitPort is the port that speaks TLS from the start; only this package's tests change it.
var implicitPort int64 = 465

// conn is a logged-in connection, each command bounded by timeout.
type conn struct {
	raw     net.Conn
	c       *smtp.Client
	timeout time.Duration
}

// step runs one exchange with a fresh deadline.
func (k *conn) step(f func() error) error {
	k.raw.SetDeadline(time.Now().Add(k.timeout))
	return f()
}

// dial connects and logs in. The connection is closed if ctx is cancelled, by the stop it
// gives back, which the caller defers.
func dial(ctx context.Context, host string, port int64, user, password string, timeoutMs int64) (*conn, func(), error) {
	if timeoutMs <= 0 {
		return nil, nil, &kindError{kind: kindFailed, err: fmt.Errorf("timeoutMs is %d: give it a positive number of milliseconds", timeoutMs)}
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	addr := net.JoinHostPort(host, strconv.FormatInt(port, 10))
	tlsConfig := &tls.Config{ServerName: host, RootCAs: roots}
	dialer := &net.Dialer{Timeout: timeout}
	var raw net.Conn
	var err error
	if port == implicitPort {
		raw, err = tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	} else {
		raw, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, nil, failed(kindConnect, err)
	}
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	k := &conn{raw: raw, timeout: timeout}
	end := func() {
		stop()
		raw.Close()
	}
	fail := func(kind int, err error) (*conn, func(), error) {
		end()
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, failed(kind, err)
	}
	if err := k.step(func() error {
		var err error
		k.c, err = smtp.NewClient(raw, host)
		return err
	}); err != nil {
		return fail(kindConnect, err)
	}
	if port != implicitPort {
		if ok, _ := k.c.Extension("STARTTLS"); !ok {
			return fail(kindConnect, fmt.Errorf("%s offers no STARTTLS, and the password won't be sent in the clear", addr))
		}
		if err := k.step(func() error { return k.c.StartTLS(tlsConfig) }); err != nil {
			return fail(kindConnect, err)
		}
	}
	_, mechs := k.c.Extension("AUTH")
	var auth smtp.Auth
	switch {
	case hasWord(mechs, "PLAIN"):
		auth = smtp.PlainAuth("", user, password, host)
	case hasWord(mechs, "LOGIN"):
		auth = &loginAuth{user: user, password: password}
	default:
		return fail(kindLogin, fmt.Errorf("%s offers neither AUTH PLAIN nor LOGIN (it offers %q)", addr, mechs))
	}
	if err := k.step(func() error { return k.c.Auth(auth) }); err != nil {
		return fail(kindLogin, err)
	}
	return k, end, nil
}

func hasWord(s, word string) bool {
	for _, w := range strings.Fields(strings.ToUpper(s)) {
		if w == word {
			return true
		}
	}
	return false
}

// loginAuth is AUTH LOGIN, which net/smtp lacks: the user, then the password, each asked for.
type loginAuth struct{ user, password string }

func (a *loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS {
		return "", nil, errors.New("won't send the password over a connection without TLS")
	}
	return "LOGIN", nil, nil
}

func (a *loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(string(fromServer))) {
	case "username:", "user name:", "username":
		return []byte(a.user), nil
	case "password:", "password":
		return []byte(a.password), nil
	}
	return nil, fmt.Errorf("unexpected AUTH LOGIN prompt %q", fromServer)
}

// Verify connects and logs in, and sends nothing.
func Verify(ctx context.Context, host string, port int64, user, password string, timeoutMs int64) error {
	k, end, err := dial(ctx, host, port, user, password, timeoutMs)
	if err != nil {
		return err
	}
	defer end()
	k.step(k.c.Quit)
	return nil
}

// Send logs in and sends data from from to each of recipients.
func Send(ctx context.Context, host string, port int64, user, password string, timeoutMs int64, from string, recipients []string, data string) error {
	if len(recipients) == 0 {
		return &kindError{kind: kindRecipient, err: errors.New("no recipients")}
	}
	k, end, err := dial(ctx, host, port, user, password, timeoutMs)
	if err != nil {
		return err
	}
	defer end()
	check := func(kind int, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return failed(kind, err)
	}
	if err := k.step(func() error { return k.c.Mail(from) }); err != nil {
		return check(kindFailed, err)
	}
	for _, r := range recipients {
		if err := k.step(func() error { return k.c.Rcpt(r) }); err != nil {
			var te *textproto.Error
			if errors.As(err, &te) {
				return &kindError{kind: kindRecipient, err: fmt.Errorf("%s: %v", r, err)}
			}
			return check(kindFailed, err)
		}
	}
	if err := k.step(func() error {
		w, err := k.c.Data()
		if err != nil {
			return err
		}
		if _, err := io.WriteString(w, data); err != nil {
			return err
		}
		return w.Close()
	}); err != nil {
		return check(kindFailed, err)
	}
	k.step(k.c.Quit)
	return nil
}
