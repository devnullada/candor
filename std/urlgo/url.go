// Package urlgo is the Go under std/url.candor: Go's net/url. A parsed URL crosses as JSON; a
// query crosses as a flat list of keys and values, so its order is kept.
package urlgo

import (
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type parts struct {
	Scheme   string  `json:"scheme"`
	User     *string `json:"user"`
	Password *string `json:"password"`
	Host     string  `json:"host"`
	Port     *int    `json:"port"`
	Path     string  `json:"path"`
	Query    string  `json:"query"`
	Fragment string  `json:"fragment"`
}

// Parse gives s's parts as JSON, or Go's reason it doesn't parse.
func Parse(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	p := parts{Scheme: u.Scheme, Host: u.Hostname(), Path: u.Path, Query: u.RawQuery, Fragment: u.Fragment}
	if u.Opaque != "" {
		// `mailto:ada@example.com`: what follows the scheme is the path, as written.
		p.Path = u.Opaque
	}
	if u.User != nil {
		name := u.User.Username()
		p.User = &name
		if pw, ok := u.User.Password(); ok {
			p.Password = &pw
		}
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err == nil {
			p.Port = &n
		}
	}
	b, _ := json.Marshal(p)
	return string(b), nil
}

// Format writes parts, from JSON, back as a URL.
func Format(s string) string {
	var p parts
	_ = json.Unmarshal([]byte(s), &p)
	u := url.URL{Scheme: p.Scheme, Host: p.Host, Path: p.Path, RawQuery: p.Query, Fragment: p.Fragment}
	if strings.Contains(p.Host, ":") {
		u.Host = "[" + p.Host + "]"
	}
	if p.Port != nil {
		u.Host = net.JoinHostPort(p.Host, strconv.Itoa(*p.Port))
	}
	if p.User != nil {
		if p.Password != nil {
			u.User = url.UserPassword(*p.User, *p.Password)
		} else {
			u.User = url.User(*p.User)
		}
	}
	if p.Scheme != "" && u.Host == "" && u.User == nil && !strings.HasPrefix(p.Path, "/") {
		// Opaque again: `mailto:` + path, not `mailto://`.
		u.Path = ""
		u.Opaque = p.Path
	}
	return u.String()
}

// Resolve reads ref against base, as a browser reads a link against the page it is on.
func Resolve(base, ref string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	return b.ResolveReference(r).String(), nil
}

// Query splits a query string into keys and values, decoded, in order: k1, v1, k2, v2, ...
// A piece that doesn't decode is kept as it came.
func Query(q string) []string {
	q = strings.TrimPrefix(q, "?")
	out := []string{}
	for _, piece := range strings.Split(q, "&") {
		if piece == "" {
			continue
		}
		k, v, _ := strings.Cut(piece, "=")
		out = append(out, unescape(k), unescape(v))
	}
	return out
}

func unescape(s string) string {
	if d, err := url.QueryUnescape(s); err == nil {
		return d
	}
	return s
}

// EncodeQuery writes keys and values (k1, v1, k2, v2, ...) as a query string, in order.
func EncodeQuery(kv []string) string {
	var b strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(kv[i]))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(kv[i+1]))
	}
	return b.String()
}

func Encode(s string) string { return url.QueryEscape(s) }

func EncodePath(s string) string { return url.PathEscape(s) }

func Decode(s string) (string, error) { return url.QueryUnescape(s) }

func DecodePath(s string) (string, error) { return url.PathUnescape(s) }
