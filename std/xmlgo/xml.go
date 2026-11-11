// Package xmlgo is the Go under std/xml.candor: a document read with encoding/xml into a tree,
// which crosses to Candor as JSON in the shape of `xml.Node` (`{"kind":"Element",...}`).
// Lenient reading is Go's Strict = false with HTML entities, as feed readers do (no HTML
// auto-closing: RSS has a <link> with text), and keeps what was read before a syntax error.
package xmlgo

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"golang.org/x/text/encoding/htmlindex"
)

type attr struct {
	Name  string `json:"name"`
	Space string `json:"space"`
	Value string `json:"value"`
}

type node struct {
	Kind     string
	Name     string
	Space    string
	Attrs    []attr
	Children []*node
	Value    string
}

// MarshalJSON writes the fields of the node's own variant only.
func (n *node) MarshalJSON() ([]byte, error) {
	if n.Kind == "Text" {
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		}{n.Kind, n.Value})
	}
	return json.Marshal(struct {
		Kind     string  `json:"kind"`
		Name     string  `json:"name"`
		Space    string  `json:"space"`
		Attrs    []attr  `json:"attrs"`
		Children []*node `json:"children"`
	}{n.Kind, n.Name, n.Space, n.Attrs, n.Children})
}

type parsed struct {
	Root    *node  `json:"root"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// charsetReader reads a document in any charset x/text knows, by the label its declaration
// gives. Leniently, a charset it doesn't know is read as UTF-8.
func charsetReader(strict bool, decoded bool) func(string, io.Reader) (io.Reader, error) {
	return func(charset string, input io.Reader) (io.Reader, error) {
		if decoded {
			// Read from the charset given, so already UTF-8, whatever the declaration says.
			return input, nil
		}
		enc, err := htmlindex.Get(charset)
		if err != nil {
			if !strict {
				return input, nil
			}
			return nil, fmt.Errorf("unknown charset %q", charset)
		}
		return enc.NewDecoder().Reader(input), nil
	}
}

// Parse reads text into a tree. The result is JSON: {"root": ...} or, when nothing could be
// read (strict: on any error), {"root": null, "line": n, "message": "..."}. A charset x/text
// knows (from an HTTP header) is read in place of the one the declaration names; "", or one it
// doesn't know, leaves the declaration's.
func Parse(text string, strict bool, charset string) string {
	decoded := false
	if enc, err := htmlindex.Get(charset); charset != "" && err == nil {
		if t, err := enc.NewDecoder().String(text); err == nil {
			text, decoded = t, true
		}
	}
	text = strings.TrimPrefix(text, string(rune(0xFEFF)))
	if !strict {
		text = clean(text, decoded)
	}
	d := xml.NewDecoder(strings.NewReader(text))
	d.CharsetReader = charsetReader(strict, decoded)
	if !strict {
		d.Strict = false
		d.Entity = xml.HTMLEntity
	}
	var root *node
	var open []*node
	fail := func(err error) string {
		line, _ := d.InputPos()
		out := parsed{Line: line, Message: strings.TrimPrefix(err.Error(), "xml: ")}
		var syn *xml.SyntaxError
		if errors.As(err, &syn) {
			out.Line, out.Message = syn.Line, syn.Msg
		}
		if i := strings.Index(out.Message, ": unknown charset"); i >= 0 {
			out.Message = out.Message[i+2:]
		}
		if out.Message == "unexpected EOF" && len(open) > 0 {
			out.Message = fmt.Sprintf("<%s> is not closed", open[len(open)-1].Name)
		}
		if !strict && root != nil {
			// Lenient: what was read stands, with the open elements closed.
			return result(parsed{Root: root})
		}
		return result(out)
	}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			if root == nil {
				return result(parsed{Line: 1, Message: "no element in the document"})
			}
			if len(open) > 0 && strict {
				line, _ := d.InputPos()
				return result(parsed{Line: line, Message: fmt.Sprintf("<%s> is not closed", open[len(open)-1].Name)})
			}
			return result(parsed{Root: root})
		}
		if err != nil {
			return fail(err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := elementOf(t)
			if len(open) > 0 {
				p := open[len(open)-1]
				p.Children = append(p.Children, n)
			} else if root == nil {
				root = n
			} else if strict {
				return fail(fmt.Errorf("a second root element <%s>", t.Name.Local))
			} else {
				// Lenient: a second root is left out, as everything after the first.
				return result(parsed{Root: root})
			}
			open = append(open, n)
		case xml.EndElement:
			if len(open) > 0 {
				open = open[:len(open)-1]
			}
		case xml.CharData:
			if len(open) == 0 {
				if strict && len(bytes.TrimSpace(t)) > 0 {
					return fail(fmt.Errorf("text outside the root element"))
				}
				continue
			}
			addText(open[len(open)-1], t)
		}
	}
}

func elementOf(t xml.StartElement) *node {
	n := &node{Kind: "Element", Name: t.Name.Local, Space: t.Name.Space, Attrs: []attr{}, Children: []*node{}}
	for _, a := range t.Attr {
		n.Attrs = append(n.Attrs, attr{Name: a.Name.Local, Space: a.Name.Space, Value: a.Value})
	}
	return n
}

// addText adds t to p's children, joined to a text node it ends with.
func addText(p *node, t xml.CharData) {
	if k := len(p.Children); k > 0 && p.Children[k-1].Kind == "Text" {
		p.Children[k-1].Value += string(t)
	} else {
		p.Children = append(p.Children, &node{Kind: "Text", Value: string(t)})
	}
}

var declared = regexp.MustCompile(`^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']*)["']`)

// clean drops the control characters XML refuses (feeds carry them), which are the same bytes
// in every charset a declaration can name, and, in a document that is UTF-8 (or decoded from
// the charset given), replaces invalid UTF-8 with U+FFFD.
func clean(text string, decoded bool) string {
	// Byte by byte: the text may not be UTF-8 yet.
	b := make([]byte, 0, len(text))
	for i := 0; i < len(text); i++ {
		if c := text[i]; c >= 0x20 || c == '\t' || c == '\n' || c == '\r' {
			b = append(b, c)
		}
	}
	text = string(b)
	if m := declared.FindStringSubmatch(text); m != nil && !decoded {
		if cs := strings.ToLower(m[1]); cs != "utf-8" && cs != "utf8" {
			return text
		}
	}
	return strings.ToValidUTF8(text, string(rune(0xFFFD)))
}

func result(p parsed) string {
	out, err := json.Marshal(p)
	if err != nil {
		panic(err)
	}
	return string(out)
}
