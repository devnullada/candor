package xmlgo

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Elements reads the document src gives as Parse reads text, but calls each with every element
// whose local name is one of names (the outermost, when they nest), as Node's JSON, and keeps
// only the rest of the tree: the elements each was given are left out of it. each returning
// false stops the reading there. The result is Parse's JSON for the rest, its root null with
// no message when the root itself was given to each. A failure of src is an error even when
// reading leniently, its message src's own, at line 0.
func Elements(src io.Reader, names []string, strict bool, charset string, each func(string) bool) string {
	in := &watched{r: src}
	r, decoded := prepare(in, strict, charset)
	d := xml.NewDecoder(r)
	d.CharsetReader = charsetReader(strict, decoded)
	if !strict {
		d.Strict = false
		d.Entity = xml.HTMLEntity
	}
	want := map[string]bool{}
	for _, n := range names {
		want[n] = true
	}
	var root *node
	var open []*node
	// The element being read for each, and its open elements.
	var item []*node
	rooted := false
	fail := func(err error) string {
		if in.err != nil {
			return result(parsed{Message: in.err.Error()})
		}
		if !strict && rooted {
			// Lenient: what was read stands, an element each hasn't had left out.
			return result(parsed{Root: root})
		}
		line, _ := d.InputPos()
		out := parsed{Line: line, Message: strings.TrimPrefix(err.Error(), "xml: ")}
		var syn *xml.SyntaxError
		if errors.As(err, &syn) {
			out.Line, out.Message = syn.Line, syn.Msg
		}
		if i := strings.Index(out.Message, ": unknown charset"); i >= 0 {
			out.Message = out.Message[i+2:]
		}
		if out.Message == "unexpected EOF" {
			if last := append(open, item...); len(last) > 0 {
				out.Message = fmt.Sprintf("<%s> is not closed", last[len(last)-1].Name)
			}
		}
		return result(out)
	}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			if in.err != nil {
				return fail(err)
			}
			if !rooted {
				return result(parsed{Line: 1, Message: "no element in the document"})
			}
			if last := append(open, item...); len(last) > 0 && strict {
				line, _ := d.InputPos()
				return result(parsed{Line: line, Message: fmt.Sprintf("<%s> is not closed", last[len(last)-1].Name)})
			}
			return result(parsed{Root: root})
		}
		if err != nil {
			return fail(err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := elementOf(t)
			switch {
			case len(item) > 0:
				p := item[len(item)-1]
				p.Children = append(p.Children, n)
				item = append(item, n)
			case len(open) == 0 && rooted:
				if strict {
					return fail(fmt.Errorf("a second root element <%s>", t.Name.Local))
				}
				return result(parsed{Root: root})
			case want[n.Name]:
				rooted = true
				item = []*node{n}
			case len(open) > 0:
				p := open[len(open)-1]
				p.Children = append(p.Children, n)
				open = append(open, n)
			default:
				rooted = true
				root = n
				open = append(open, n)
			}
		case xml.EndElement:
			if len(item) > 0 {
				whole := item[0]
				if item = item[:len(item)-1]; len(item) == 0 {
					got, err := json.Marshal(whole)
					if err != nil {
						panic(err)
					}
					if !each(string(got)) {
						return result(parsed{Root: root})
					}
				}
				continue
			}
			if len(open) > 0 {
				open = open[:len(open)-1]
			}
		case xml.CharData:
			switch {
			case len(item) > 0:
				addText(item[len(item)-1], t)
			case len(open) > 0:
				addText(open[len(open)-1], t)
			case strict && len(bytes.TrimSpace(t)) > 0:
				return fail(fmt.Errorf("text outside the root element"))
			}
		}
	}
}

// watched keeps the error its reader gave, to tell a failed read from a document cut short.
type watched struct {
	r   io.Reader
	err error
}

func (w *watched) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	if err != nil && err != io.EOF {
		w.err = err
	}
	return n, err
}

// prepare is Parse's preparation of text, as src arrives: the BOM dropped, the charset given
// decoded (decoded says so), and leniently the control characters dropped and, in a document
// that is UTF-8, invalid UTF-8 read as U+FFFD. The declaration is looked for in the first KiB.
func prepare(src io.Reader, strict bool, charset string) (io.Reader, bool) {
	br := bufio.NewReaderSize(src, 4096)
	if head, _ := br.Peek(3); bytes.Equal(head, []byte("\xef\xbb\xbf")) {
		br.Discard(3)
	}
	var r io.Reader = br
	decoded := false
	if enc, err := htmlindex.Get(charset); charset != "" && err == nil {
		r, decoded = enc.NewDecoder().Reader(br), true
	}
	if strict {
		return r, decoded
	}
	head, _ := br.Peek(1024)
	r = controlsDropped{r}
	if m := declared.FindSubmatch(dropControls(bytes.Clone(head))); m != nil && !decoded {
		if cs := strings.ToLower(string(m[1])); cs != "utf-8" && cs != "utf8" {
			return r, decoded
		}
	}
	return transform.NewReader(r, unicode.UTF8.NewDecoder()), decoded
}

// controlsDropped reads r without the control characters XML refuses, as clean drops them.
type controlsDropped struct{ r io.Reader }

func (c controlsDropped) Read(p []byte) (int, error) {
	for {
		n, err := c.r.Read(p)
		k := len(dropControls(p[:n]))
		if k > 0 || err != nil || n == 0 {
			return k, err
		}
	}
}

// dropControls removes the control characters from b in place, and gives what is left.
func dropControls(b []byte) []byte {
	k := 0
	for _, c := range b {
		if c >= 0x20 || c == '\t' || c == '\n' || c == '\r' {
			b[k] = c
			k++
		}
	}
	return b[:k]
}
