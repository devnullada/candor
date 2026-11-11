package imapgo

// The real client against go-imap's own server (memory backend: user "username", password
// "password", INBOX holding one message) over TLS on 127.0.0.1, with a certificate made here.
// test/imap.test.ts copies this file into a built program's module and runs it there.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/backend/memory"
	"github.com/emersion/go-imap/server"
)

func serve(t *testing.T) int64 {
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

	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	s := server.New(memory.New())
	go s.Serve(l)
	t.Cleanup(func() { s.Close() })
	return int64(l.Addr().(*net.TCPAddr).Port)
}

func TestSession(t *testing.T) {
	port := serve(t)
	ctx := context.Background()
	id, err := Open(ctx, "localhost", port, "username", "password", 5000)
	if err != nil {
		t.Fatal(err)
	}
	folders, err := Folders(ctx, id)
	if err != nil || len(folders) != 3 || folders[0] != "INBOX" {
		t.Fatalf("folders: %q, %v", folders, err)
	}
	sel, err := Select(ctx, id, "INBOX")
	if err != nil || sel[1] != "1" {
		t.Fatalf("select: %q, %v", sel, err)
	}
	got, err := Fetch(ctx, id, 1, 1, false)
	if err != nil || len(got) != 3 || !strings.Contains(got[2], "Subject: A little message, just for you\r\n") {
		t.Fatalf("fetch: %q, %v", got, err)
	}
	uid, _ := strconv.Atoi(got[0])
	// Above the newest UID, `n:*` answers with the newest on real servers (this one sends
	// nothing): Candor filters it.
	above, err := Fetch(ctx, id, int64(uid)+1, 0, true)
	if err != nil || (len(above) != 0 && above[0] != got[0]) {
		t.Fatalf("fetch above: %q, %v", above, err)
	}
	if _, err := Select(ctx, id, "Nope"); Kind(err) != kindNoFolder {
		t.Fatalf("missing folder: %v (kind %d)", err, Kind(err))
	}
	Close(id)
	if _, err := Folders(ctx, id); err == nil {
		t.Fatal("a closed session still answers")
	}
	Close(id)
}

func TestFailures(t *testing.T) {
	port := serve(t)
	ctx := context.Background()
	if _, err := Open(ctx, "localhost", port, "username", "wrong", 5000); Kind(err) != kindLogin {
		t.Fatalf("wrong password: %v (kind %d)", err, Kind(err))
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := int64(l.Addr().(*net.TCPAddr).Port)
	l.Close()
	if _, err := Open(ctx, "localhost", closed, "username", "password", 5000); Kind(err) != kindConnect {
		t.Fatalf("closed port: %v (kind %d)", err, Kind(err))
	}
	// A server that accepts and says nothing: the TLS handshake times out.
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
	_, err := Open(ctx, "localhost", int64(quiet.Addr().(*net.TCPAddr).Port), "username", "password", 300)
	if Kind(err) != kindTimeout || time.Since(start) > 3*time.Second {
		t.Fatalf("quiet server: %v (kind %d) after %v", err, Kind(err), time.Since(start))
	}
	if _, err := Open(ctx, "localhost", port, "username", "password", 0); err == nil {
		t.Fatal("a zero timeout is accepted")
	}
}
