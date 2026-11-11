package smtpgo

// The real client against a small SMTP server made here, on 127.0.0.1 with a certificate made
// here: implicit TLS or STARTTLS, AUTH PLAIN or LOGIN only, one refused recipient.
// test/smtp.test.ts copies this file into a built program's module and runs it there.

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

type server struct {
	port     int64
	mu       sync.Mutex
	received []string // "from|to,to|data"
}

func certificate(t *testing.T) tls.Certificate {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "localhost"},
		DNSNames:              []string{"localhost"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	roots = x509.NewCertPool()
	roots.AddCert(cert)
	t.Cleanup(func() { roots = nil })
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// serve starts a server: implicit TLS when implicit, else STARTTLS; auth is the one mechanism
// it offers ("PLAIN" or "LOGIN"); "" offers STARTTLS not at all, for a plain-only server.
func serve(t *testing.T, implicit bool, auth string, starttls bool) *server {
	cert := certificate(t)
	config := &tls.Config{Certificates: []tls.Certificate{cert}}
	var l net.Listener
	var err error
	if implicit {
		l, err = tls.Listen("tcp", "127.0.0.1:0", config)
	} else {
		l, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	s := &server{port: int64(l.Addr().(*net.TCPAddr).Port)}
	if implicit {
		implicitPort = s.port
		t.Cleanup(func() { implicitPort = 465 })
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go s.talk(c, config, implicit, auth, starttls)
		}
	}()
	return s
}

func (s *server) talk(c net.Conn, config *tls.Config, secure bool, auth string, starttls bool) {
	defer func() { c.Close() }()
	r := bufio.NewReader(c)
	say := func(line string) { c.Write([]byte(line + "\r\n")) }
	read := func() string {
		line, _ := r.ReadString('\n')
		return strings.TrimRight(line, "\r\n")
	}
	say("220 localhost ready")
	var from string
	var to []string
	authed := false
	for {
		line := read()
		verb := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
		switch verb {
		case "EHLO", "HELO":
			say("250-localhost")
			if !secure && starttls {
				say("250-STARTTLS")
			}
			if secure {
				say("250-AUTH " + auth)
			}
			say("250 8BITMIME")
		case "STARTTLS":
			say("220 go ahead")
			tc := tls.Server(c, config)
			if tc.Handshake() != nil {
				return
			}
			c, r, secure = tc, bufio.NewReader(tc), true
		case "AUTH":
			user, pass := "", ""
			parts := strings.Fields(line)
			if len(parts) >= 2 && strings.ToUpper(parts[1]) == "PLAIN" {
				raw := ""
				if len(parts) == 3 {
					raw = parts[2]
				} else {
					say("334 ")
					raw = read()
				}
				b, _ := base64.StdEncoding.DecodeString(raw)
				f := strings.Split(string(b), "\x00")
				if len(f) == 3 {
					user, pass = f[1], f[2]
				}
			} else if len(parts) >= 2 && strings.ToUpper(parts[1]) == "LOGIN" {
				say("334 " + base64.StdEncoding.EncodeToString([]byte("Username:")))
				u, _ := base64.StdEncoding.DecodeString(read())
				say("334 " + base64.StdEncoding.EncodeToString([]byte("Password:")))
				p, _ := base64.StdEncoding.DecodeString(read())
				user, pass = string(u), string(p)
			}
			if user == "dev@example.com" && pass == "app" {
				authed = true
				say("235 ok")
			} else {
				say("535 5.7.8 authentication failed")
			}
		case "MAIL":
			if !authed {
				say("530 authenticate first")
				continue
			}
			from = strings.TrimSuffix(strings.TrimPrefix(line[len("MAIL FROM:"):], "<"), ">")
			if i := strings.Index(from, ">"); i >= 0 {
				from = from[:i]
			}
			say("250 ok")
		case "RCPT":
			addr := strings.TrimSuffix(strings.TrimPrefix(line[len("RCPT TO:"):], "<"), ">")
			if addr == "nobody@example.com" {
				say("550 5.1.1 no such user")
				continue
			}
			to = append(to, addr)
			say("250 ok")
		case "DATA":
			say("354 go on")
			var b strings.Builder
			for {
				l := read()
				if l == "." {
					break
				}
				b.WriteString(strings.TrimPrefix(l, ".") + "\n")
			}
			s.mu.Lock()
			s.received = append(s.received, from+"|"+strings.Join(to, ",")+"|"+b.String())
			s.mu.Unlock()
			say("250 queued")
		case "RSET":
			from, to = "", nil
			say("250 ok")
		case "QUIT":
			say("221 bye")
			return
		case "":
			return
		default:
			say("502 not implemented")
		}
	}
}

func (s *server) got() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.received...)
}

const message = "Subject: hi\r\n\r\n.hello\r\n"

func TestImplicitPlain(t *testing.T) {
	s := serve(t, true, "PLAIN LOGIN", false)
	ctx := context.Background()
	if err := Verify(ctx, "localhost", s.port, "dev@example.com", "app", 5000); err != nil {
		t.Fatal(err)
	}
	if err := Send(ctx, "localhost", s.port, "dev@example.com", "app", 5000, "dev@example.com", []string{"a@example.com", "b@example.com"}, message); err != nil {
		t.Fatal(err)
	}
	got := s.got()
	if len(got) != 1 || got[0] != "dev@example.com|a@example.com,b@example.com|Subject: hi\n\n.hello\n" {
		t.Fatalf("received %q", got)
	}
}

func TestStartTLSLogin(t *testing.T) {
	s := serve(t, false, "LOGIN", true)
	ctx := context.Background()
	if err := Send(ctx, "localhost", s.port, "dev@example.com", "app", 5000, "dev@example.com", []string{"a@example.com"}, message); err != nil {
		t.Fatal(err)
	}
	if len(s.got()) != 1 {
		t.Fatalf("received %q", s.got())
	}
}

func TestFailures(t *testing.T) {
	ctx := context.Background()
	s := serve(t, true, "PLAIN", false)
	if err := Verify(ctx, "localhost", s.port, "dev@example.com", "wrong", 5000); Kind(err) != kindLogin {
		t.Fatalf("wrong password: %v (kind %d)", err, Kind(err))
	}
	err := Send(ctx, "localhost", s.port, "dev@example.com", "app", 5000, "dev@example.com", []string{"a@example.com", "nobody@example.com"}, message)
	if Kind(err) != kindRecipient || !strings.Contains(err.Error(), "nobody@example.com") {
		t.Fatalf("refused recipient: %v (kind %d)", err, Kind(err))
	}
	if len(s.got()) != 0 {
		t.Fatalf("sent despite a refused recipient: %q", s.got())
	}
	if err := Send(ctx, "localhost", s.port, "dev@example.com", "app", 5000, "dev@example.com", nil, message); Kind(err) != kindRecipient {
		t.Fatalf("no recipients: %v (kind %d)", err, Kind(err))
	}

	plain := serve(t, false, "PLAIN", false)
	if err := Verify(ctx, "localhost", plain.port, "dev@example.com", "app", 5000); Kind(err) != kindConnect || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("no STARTTLS: %v (kind %d)", err, Kind(err))
	}

	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := int64(l.Addr().(*net.TCPAddr).Port)
	l.Close()
	if err := Verify(ctx, "localhost", closed, "dev@example.com", "app", 5000); Kind(err) != kindConnect {
		t.Fatalf("closed port: %v (kind %d)", err, Kind(err))
	}

	quiet, _ := net.Listen("tcp", "127.0.0.1:0")
	defer quiet.Close()
	go func() {
		for {
			c, err := quiet.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	start := time.Now()
	err = Verify(ctx, "localhost", int64(quiet.Addr().(*net.TCPAddr).Port), "dev@example.com", "app", 300)
	if Kind(err) != kindTimeout || time.Since(start) > 3*time.Second {
		t.Fatalf("quiet server: %v (kind %d) after %v", err, Kind(err), time.Since(start))
	}
}
