// Package htmlgo is the Go under std/html.candor: HTML read with x/net/html, as a browser
// would (it never fails), and written out as the text a reader sees. Mail is the main reader:
// its layout is tables, and its paragraph gaps are CSS padding, so both are read.
package htmlgo

import (
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// What has no text to show.
var skipped = map[atom.Atom]bool{
	atom.Head: true, atom.Script: true, atom.Style: true, atom.Template: true,
	atom.Noscript: true, atom.Svg: true, atom.Iframe: true, atom.Object: true,
}

// Blocks set apart from what is around them by a blank line.
var paragraphs = map[atom.Atom]bool{
	atom.P: true, atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true,
	atom.Blockquote: true, atom.Pre: true, atom.Ul: true, atom.Ol: true, atom.Dl: true, atom.Table: true,
	atom.Hr: true, atom.Figure: true,
}

// Blocks that start on a line of their own.
var lines = map[atom.Atom]bool{
	atom.Div: true, atom.Li: true, atom.Tr: true, atom.Dt: true, atom.Dd: true, atom.Section: true,
	atom.Article: true, atom.Header: true, atom.Footer: true, atom.Nav: true, atom.Aside: true,
	atom.Main: true, atom.Address: true, atom.Form: true, atom.Fieldset: true, atom.Caption: true,
	atom.Figcaption: true, atom.Details: true, atom.Summary: true, atom.Center: true,
	atom.Tbody: true, atom.Thead: true, atom.Tfoot: true,
}

func isCell(a atom.Atom) bool { return a == atom.Td || a == atom.Th }

func isBlock(a atom.Atom) bool { return paragraphs[a] || lines[a] || isCell(a) }

type writer struct {
	b     strings.Builder
	brk   int  // line ends owed before the next text: 1 a new line, 2 a blank line
	space bool // a space owed before the next text
	sep   bool // a cell separator owed before the next text, in a row kept on one line
	wrote bool // the row being written has text
	pre   int  // inside <pre>: whitespace is kept
	ends  int  // line ends the output ends with
	last  link // the link written last
}

type link struct {
	href, text string
	end        int  // the output's length after it
	addressed  bool // its address was written
}

func (w *writer) put(s string) {
	w.b.WriteString(s)
	if t := strings.TrimRight(s, "\n"); t == "" {
		w.ends += len(s)
	} else {
		w.ends = len(s) - len(t)
	}
}

// block owes n line ends, as a block's start or end does.
func (w *writer) block(n int) {
	w.brk = max(w.brk, n)
	w.space, w.sep = false, false
}

// raw writes s after what is owed, as it is.
func (w *writer) raw(s string) {
	if s == "" {
		return
	}
	if w.b.Len() > 0 {
		switch {
		case w.brk > w.ends:
			w.put(strings.Repeat("\n", w.brk-w.ends))
		case w.brk == 0 && w.ends == 0 && w.sep:
			w.put(" | ")
		case w.brk == 0 && w.ends == 0 && w.space:
			w.put(" ")
		}
	}
	w.brk, w.space, w.sep = 0, false, false
	w.wrote = true
	w.put(s)
}

// text writes a text node: outside <pre>, a run of whitespace is one space.
func (w *writer) text(s string) {
	if w.pre > 0 {
		w.raw(s)
		return
	}
	words := strings.Join(strings.Fields(s), " ")
	if words == "" {
		w.space = w.space || s != ""
		return
	}
	if s != strings.TrimLeftFunc(s, unicode.IsSpace) {
		w.space = true
	}
	w.raw(words)
	w.space = s != strings.TrimRightFunc(s, unicode.IsSpace)
}

func (w *writer) walk(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		w.text(n.Data)
		return
	case html.CommentNode, html.DoctypeNode:
		return
	case html.ElementNode:
		if skipped[n.DataAtom] || hidden(n) {
			return
		}
	}
	a := n.DataAtom
	gapBefore, gapAfter := false, false
	if isBlock(a) {
		gapBefore, gapAfter = gaps(n)
	}
	switch {
	case a == atom.Br:
		if w.b.Len() > 0 {
			w.brk, w.sep = 0, false
			w.put("\n")
		}
		w.space = false
		return
	case a == atom.Img:
		if alt := altOf(n); alt != "" {
			w.text(" " + alt + " ")
		}
		return
	case a == atom.A:
		w.link(n)
		return
	case paragraphs[a] || gapBefore:
		w.block(2)
	case lines[a]:
		w.block(1)
	}
	if a == atom.Tr {
		w.wrote = false
	}
	// A row of plain cells reads as one line, `a | b`. Cells holding blocks or line breaks
	// are laid out side by side: each is read on its own, a cell of several lines set apart
	// by a blank line, so its last line doesn't run into the next cell's first.
	inRow := isCell(a) && n.Parent != nil && n.Parent.DataAtom == atom.Tr && plainRow(n.Parent)
	cellBreak := 1
	if isCell(a) && !inRow && strings.Contains(render(n), "\n") {
		cellBreak = 2
	}
	if isCell(a) {
		if !inRow {
			w.block(cellBreak)
		} else if w.wrote {
			w.sep = true
		}
	}
	if a == atom.Li {
		w.raw("- ")
	}
	if a == atom.Pre {
		w.pre++
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		w.walk(c)
	}
	if a == atom.Pre {
		w.pre--
	}
	switch {
	case paragraphs[a] || gapAfter:
		w.block(2)
	case lines[a]:
		w.block(1)
	case isCell(a) && !inRow:
		w.block(cellBreak)
	}
}

// link writes a link's content, then its address on the line its text ends, when it has text
// of its own (an image's `alt` isn't) that doesn't name the address. The same link again with
// nothing written between, as an icon and its caption are, is said once.
func (w *writer) link(n *html.Node) {
	href := strings.TrimSpace(attr(n, "href"))
	own := strings.Join(strings.Fields(textOf(n)), " ")
	addressable := (strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://")) && own != "" &&
		!strings.Contains(bare(own), bare(href))
	shown := strings.Join(strings.Fields(shownText(n)), " ")
	address := func() {
		owed := w.brk
		w.brk, w.sep, w.space = 0, false, true
		w.raw("(" + href + ")")
		w.brk = owed
	}
	if href != "" && shown != "" && w.last.href == href && w.last.text == shown && w.b.Len() == w.last.end {
		if addressable && !w.last.addressed {
			w.brk = 0
			address()
			w.last.addressed, w.last.end = true, w.b.Len()
		}
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		w.walk(c)
	}
	if addressable {
		address()
	}
	w.last = link{href: href, text: shown, end: w.b.Len(), addressed: addressable}
}

// altOf is an image's `alt`, unless it is an address rather than words.
func altOf(n *html.Node) string {
	alt := strings.TrimSpace(attr(n, "alt"))
	if l := strings.ToLower(alt); strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "www.") {
		return ""
	}
	return alt
}

// shownText is what a node shows: its text and its images' `alt`.
func shownText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	if n.Type == html.ElementNode && (skipped[n.DataAtom] || hidden(n)) {
		return ""
	}
	if n.DataAtom == atom.Img {
		return " " + altOf(n) + " "
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(shownText(c))
		b.WriteString(" ")
	}
	return b.String()
}

// plainRow: each cell holds text and inline elements only.
func plainRow(tr *html.Node) bool {
	for c := tr.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && isCell(c.DataAtom) && !inline(c) {
			return false
		}
	}
	return true
}

func inline(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || skipped[c.DataAtom] || hidden(c) {
			continue
		}
		if isBlock(c.DataAtom) || c.DataAtom == atom.Br || !inline(c) {
			return false
		}
	}
	return true
}

// style reads an element's `style` attribute: property to value, lowercase.
func style(n *html.Node) map[string]string {
	out := map[string]string{}
	for _, decl := range strings.Split(attr(n, "style"), ";") {
		k, v, ok := strings.Cut(decl, ":")
		if ok {
			v = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(strings.ToLower(v)), "!important"))
			out[strings.TrimSpace(strings.ToLower(k))] = v
		}
	}
	return out
}

func hidden(n *html.Node) bool {
	return n.Type == html.ElementNode && style(n)["display"] == "none"
}

// gaps: whether padding or margin opens a line's worth of space above and below the block.
func gaps(n *html.Node) (before, after bool) {
	s := style(n)
	side := func(prop string, i int) bool {
		if v, ok := s[prop+"-"+[]string{"top", "bottom"}[i]]; ok {
			return visible(v)
		}
		parts := strings.Fields(s[prop])
		switch {
		case len(parts) == 0:
			return false
		case i == 0 || len(parts) < 3:
			return visible(parts[0])
		default:
			return visible(parts[2])
		}
	}
	return side("padding", 0) || side("margin", 0), side("padding", 1) || side("margin", 1)
}

// visible: a length a reader sees as a gap between lines (8px, 0.5em, any percentage).
func visible(v string) bool {
	num := strings.TrimRight(v, "abcdefghijklmnopqrstuvwxyz%")
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return false
	}
	switch v[len(num):] {
	case "px", "":
		return f >= 8
	case "pt":
		return f >= 6
	case "em", "rem":
		return f >= 0.5
	default:
		return f > 0
	}
}

// bare is an address without its scheme, `www.` or trailing `/`: `www.x.io` names `https://x.io/`.
func bare(s string) string {
	s = strings.ToLower(s)
	for _, p := range []string{"https://", "http://", "www."} {
		s = strings.TrimPrefix(s, p)
	}
	return strings.TrimSuffix(s, "/")
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// ToText is the text a reader sees on the page.
func ToText(s string) string {
	doc, err := html.Parse(strings.NewReader(s))
	if err != nil {
		// Only a reader's error stops it, and a strings.Reader has none.
		return ""
	}
	return render(doc)
}

// render is a node's text, trimmed, with one blank line at most between lines.
func render(n *html.Node) string {
	w := &writer{}
	if isCell(n.DataAtom) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			w.walk(c)
		}
	} else {
		w.walk(n)
	}
	var out []string
	blank := 0
	for _, l := range strings.Split(w.b.String(), "\n") {
		l = strings.TrimRight(l, " \t\r ")
		if l == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, l)
	}
	return strings.Trim(strings.Join(out, "\n"), "\n")
}
