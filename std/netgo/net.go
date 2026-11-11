// Package netgo is the Go under std/net.candor: DNS lookups and a TCP probe, over Go's net
// package. Bindings pass ints, strings and lists of strings, so an MX record crosses as two
// items, its priority then its host.
package netgo

import (
	"context"
	"errors"
	"net"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// lookupTimeout bounds every DNS lookup.
const lookupTimeout = 5 * time.Second

var resolver = net.DefaultResolver

func within(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

// LookupA is the IPv4 addresses of name, as text.
func LookupA(ctx context.Context, name string) ([]string, error) {
	return lookupIP(ctx, "ip4", name)
}

// LookupAAAA is the IPv6 addresses of name, as text.
func LookupAAAA(ctx context.Context, name string) ([]string, error) {
	return lookupIP(ctx, "ip6", name)
}

func lookupIP(ctx context.Context, network, name string) ([]string, error) {
	ctx, cancel := within(ctx, lookupTimeout)
	defer cancel()
	ips, err := resolver.LookupIP(ctx, network, name)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(ips))
	for i, ip := range ips {
		out[i] = ip.String()
	}
	sort.Strings(out)
	return out, nil
}

// LookupCNAME is the canonical name of name, without the trailing dot.
func LookupCNAME(ctx context.Context, name string) (string, error) {
	ctx, cancel := within(ctx, lookupTimeout)
	defer cancel()
	c, err := resolver.LookupCNAME(ctx, name)
	return strings.TrimSuffix(c, "."), err
}

// LookupNS is the name servers of name, without trailing dots, sorted.
func LookupNS(ctx context.Context, name string) ([]string, error) {
	ctx, cancel := within(ctx, lookupTimeout)
	defer cancel()
	ns, err := resolver.LookupNS(ctx, name)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = strings.TrimSuffix(n.Host, ".")
	}
	sort.Strings(out)
	return out, nil
}

// LookupMX is the mail servers of name, by priority: priority, host, priority, host, ...
func LookupMX(ctx context.Context, name string) ([]string, error) {
	ctx, cancel := within(ctx, lookupTimeout)
	defer cancel()
	mx, err := resolver.LookupMX(ctx, name)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, 2*len(mx))
	for _, m := range mx {
		out = append(out, strconv.Itoa(int(m.Pref)), strings.TrimSuffix(m.Host, "."))
	}
	return out, nil
}

// LookupTXT is the TXT records of name, each one's strings joined.
func LookupTXT(ctx context.Context, name string) ([]string, error) {
	ctx, cancel := within(ctx, lookupTimeout)
	defer cancel()
	return resolver.LookupTXT(ctx, name)
}

// Reach opens a TCP connection to host:port and closes it: the milliseconds it took.
func Reach(ctx context.Context, host string, port int64, timeoutMs int64) (int64, error) {
	if timeoutMs <= 0 {
		return 0, errors.New("timeoutMs must be a positive number of milliseconds")
	}
	ctx, cancel := within(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	start := time.Now()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.FormatInt(port, 10)))
	if err != nil {
		return 0, err
	}
	conn.Close()
	return time.Since(start).Milliseconds(), nil
}

// Kind sorts a failure for NetError: 0 not found, 1 timeout, 2 refused, 3 anything else.
func Kind(err error) int64 {
	var dns *net.DNSError
	if errors.As(err, &dns) && dns.IsNotFound {
		return 0
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return 1
	}
	var errno syscall.Errno
	if errors.Is(err, syscall.ECONNREFUSED) || (errors.As(err, &errno) && errno == wsaConnRefused) {
		return 2
	}
	return 3
}

// wsaConnRefused is Windows' own ECONNREFUSED, which syscall.ECONNREFUSED doesn't match there.
const wsaConnRefused = syscall.Errno(10061)
