package htmlgo

// HTML read into a tree, as a browser builds it, which crosses to Candor as JSON in the shape of
// `xml.Node` (`{"kind":"Element",...}`); and such a tree written back as html.Render writes it.
// Comments and the DOCTYPE are left out. SVG and MathML elements carry their namespace URL, as
// xml's do, and their xlink:, xml: and xmlns: attributes theirs.

import (
	"encoding/json"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

type treeAttr struct {
	Name  string `json:"name"`
	Space string `json:"space"`
	Value string `json:"value"`
}

type node struct {
	Kind     string  `json:"kind"`
	Name     string  `json:"name,omitempty"`
	Space    string  `json:"space"`
	Attrs    []treeAttr  `json:"attrs,omitempty"`
	Children []*node `json:"children,omitempty"`
	Value    string  `json:"value,omitempty"`
}

// MarshalJSON writes the fields of the node's own variant only.
func (n *node) MarshalJSON() ([]byte, error) {
	if n.Kind == "Text" {
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		}{n.Kind, n.Value})
	}
	attrs, children := n.Attrs, n.Children
	if attrs == nil {
		attrs = []treeAttr{}
	}
	if children == nil {
		children = []*node{}
	}
	return json.Marshal(struct {
		Kind     string  `json:"kind"`
		Name     string  `json:"name"`
		Space    string  `json:"space"`
		Attrs    []treeAttr  `json:"attrs"`
		Children []*node `json:"children"`
	}{n.Kind, n.Name, n.Space, attrs, children})
}

// x/net/html's short namespace names, and the URLs xml.Node carries.
var spaces = map[string]string{
	"svg":   "http://www.w3.org/2000/svg",
	"math":  "http://www.w3.org/1998/Math/MathML",
	"xlink": "http://www.w3.org/1999/xlink",
	"xml":   "http://www.w3.org/XML/1998/namespace",
	"xmlns": "xmlns",
}

func spaceOf(short string) string {
	if url, ok := spaces[short]; ok {
		return url
	}
	return short
}

func shortOf(url string) string {
	for short, u := range spaces {
		if u == url {
			return short
		}
	}
	return url
}

// toTree turns an x/net/html node into ours; nil for what is left out.
func toTree(n *html.Node) *node {
	switch n.Type {
	case html.TextNode:
		return &node{Kind: "Text", Value: n.Data}
	case html.ElementNode:
		out := &node{Kind: "Element", Name: n.Data, Space: spaceOf(n.Namespace)}
		for _, a := range n.Attr {
			out.Attrs = append(out.Attrs, treeAttr{Name: a.Key, Space: spaceOf(a.Namespace), Value: a.Val})
		}
		out.Children = kids(n)
		return out
	}
	return nil
}

func kids(n *html.Node) []*node {
	var out []*node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if k := toTree(c); k != nil {
			out = append(out, k)
		}
	}
	return out
}

func asJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// Parse reads a whole page: the JSON of its <html> element, with head and body.
func Parse(s string) string {
	doc, _ := html.Parse(strings.NewReader(s)) // reading a string never fails
	for c := doc.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			return asJSON(toTree(c))
		}
	}
	return asJSON(&node{Kind: "Element", Name: "html"})
}

// ParseFragment reads what is inside a <body>: the JSON of a list of nodes.
func ParseFragment(s string) string {
	body := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	ns, _ := html.ParseFragment(strings.NewReader(s), body)
	out := []*node{}
	for _, n := range ns {
		if k := toTree(n); k != nil {
			out = append(out, k)
		}
	}
	return asJSON(out)
}

// addTree appends ours, turned back into x/net/html nodes, to parent. A void element given
// children (built in code; html.Render refuses one) is followed by them, as a browser reads
// `<br>text`.
func addTree(parent *html.Node, n *node) {
	if n.Kind == "Text" {
		parent.AppendChild(&html.Node{Type: html.TextNode, Data: n.Value})
		return
	}
	out := &html.Node{Type: html.ElementNode, Data: n.Name, Namespace: shortOf(n.Space)}
	if out.Namespace == "" {
		out.DataAtom = atom.Lookup([]byte(n.Name))
	}
	for _, a := range n.Attrs {
		out.Attr = append(out.Attr, html.Attribute{Key: a.Name, Namespace: shortOf(a.Space), Val: a.Value})
	}
	parent.AppendChild(out)
	into := out
	if out.Namespace == "" && voids[n.Name] {
		into = parent
	}
	for _, c := range n.Children {
		addTree(into, c)
	}
}

var voids = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true,
	"input": true, "keygen": true, "link": true, "meta": true, "param": true, "source": true,
	"track": true, "wbr": true,
}

// Encode writes the JSON of a node as HTML, as html.Render does.
func Encode(tree string) string {
	var n node
	if err := json.Unmarshal([]byte(tree), &n); err != nil {
		panic(err)
	}
	doc := &html.Node{Type: html.DocumentNode}
	addTree(doc, &n)
	var b strings.Builder
	if err := html.Render(&b, doc); err != nil {
		panic(err)
	}
	return b.String()
}
