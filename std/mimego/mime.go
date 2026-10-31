// Package mimego is the Go under std/mime.candor: a raw RFC 5322 message parsed with net/mail
// and mime/multipart (charsets from golang.org/x/text), and a plain-text message composed.
// Bindings pass ints, strings and lists of strings, so a parsed message crosses as JSON, its
// attachments' bytes in base64, for std/mime.candor to decode into its structs.
package mimego

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/htmlindex"
)

type address struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

type attachment struct {
	Filename    *string `json:"filename"`
	ContentType string  `json:"contentType"`
	Size        int     `json:"size"`
	ContentID   *string `json:"contentId"`
	Inline      bool    `json:"inline"`
	Data        string  `json:"data"`
}

type message struct {
	MessageID   *string             `json:"messageId"`
	InReplyTo   *string             `json:"inReplyTo"`
	References  []string            `json:"references"`
	Subject     *string             `json:"subject"`
	Date        *int64              `json:"date"`
	From        *address            `json:"from"`
	To          []address           `json:"to"`
	Cc          []address           `json:"cc"`
	ReplyTo     []address           `json:"replyTo"`
	Text        *string             `json:"text"`
	HTML        *string             `json:"html"`
	Attachments []attachment        `json:"attachments"`
	Headers     map[string][]string `json:"headers"`
}

// charsetReader reads text in any charset x/text knows, by its MIME or WHATWG label.
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return nil, fmt.Errorf("unknown charset %q", charset)
	}
	return enc.NewDecoder().Reader(input), nil
}

var words = &mime.WordDecoder{CharsetReader: charsetReader}

// decodeHeader is a header's text with RFC 2047 encoded words decoded; as written if they can't be.
func decodeHeader(s string) string {
	out, err := words.DecodeHeader(s)
	if err != nil {
		return s
	}
	return out
}

var bracketed = regexp.MustCompile(`<([^<>]*)>`)

// ids is every message id in a header, without angle brackets: those in `<...>`, else the
// words of it.
func ids(s string) []string {
	out := []string{}
	for _, m := range bracketed.FindAllStringSubmatch(s, -1) {
		if id := strings.TrimSpace(m[1]); id != "" {
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		out = append(out, strings.Fields(s)...)
	}
	return out
}

func firstID(s string) *string {
	if all := ids(s); len(all) > 0 {
		return &all[0]
	}
	return nil
}

var looseAddress = regexp.MustCompile(`[^\s<>,;"]+@[^\s<>,;"]+`)

// addresses parses an address list; a list net/mail refuses still gives the addresses in it.
func addresses(s string) []address {
	out := []address{}
	if strings.TrimSpace(s) == "" {
		return out
	}
	parser := mail.AddressParser{WordDecoder: words}
	if list, err := parser.ParseList(s); err == nil {
		for _, a := range list {
			out = append(out, address{Name: a.Name, Address: a.Address})
		}
		return out
	}
	for _, piece := range strings.Split(s, ",") {
		if a, err := parser.Parse(piece); err == nil {
			out = append(out, address{Name: a.Name, Address: a.Address})
		} else if m := looseAddress.FindString(piece); m != "" {
			out = append(out, address{Address: m})
		}
	}
	return out
}

// Parse reads a raw message: its JSON for std/mime.candor, or why it isn't a message at all.
func Parse(raw string) (string, error) {
	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("not a mail message: %v", err)
	}
	h := msg.Header
	out := message{
		References:  ids(h.Get("References")),
		To:          addresses(h.Get("To")),
		Cc:          addresses(h.Get("Cc")),
		ReplyTo:     addresses(h.Get("Reply-To")),
		Attachments: []attachment{},
		Headers:     map[string][]string{},
	}
	for k, v := range h {
		out.Headers[strings.ToLower(k)] = v
	}
	if v := h.Get("Message-Id"); v != "" {
		out.MessageID = firstID(v)
	}
	if v := h.Get("In-Reply-To"); v != "" {
		out.InReplyTo = firstID(v)
	}
	if _, ok := h["Subject"]; ok {
		s := decodeHeader(h.Get("Subject"))
		out.Subject = &s
	}
	if t, err := mail.ParseDate(h.Get("Date")); err == nil {
		ms := t.UnixMilli()
		out.Date = &ms
	}
	if from := addresses(h.Get("From")); len(from) > 0 {
		out.From = &from[0]
	}
	var texts, htmls []string
	walk(textproto.MIMEHeader(h), msg.Body, false, &texts, &htmls, &out.Attachments)
	if len(texts) > 0 {
		s := strings.Join(texts, "\n")
		out.Text = &s
	}
	if len(htmls) > 0 {
		s := strings.Join(htmls, "\n")
		out.HTML = &s
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// walk reads one part: text into texts or htmls, anything else, or a part sent as an
// attachment, into atts. In a multipart/alternative only the first plain and the first HTML
// alternative count: the rest say the same again.
func walk(h textproto.MIMEHeader, body io.Reader, alternative bool, texts, htmls *[]string, atts *[]attachment) {
	ctype, params, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil || ctype == "" {
		ctype, params = "text/plain", map[string]string{}
	}
	data := decodeTransfer(h.Get("Content-Transfer-Encoding"), body)

	if strings.HasPrefix(ctype, "multipart/") && params["boundary"] != "" {
		r := multipart.NewReader(bytes.NewReader(data), params["boundary"])
		var ts, hs []string
		for {
			part, err := r.NextRawPart()
			if err != nil {
				break
			}
			walk(part.Header, part, ctype == "multipart/alternative", &ts, &hs, atts)
		}
		if ctype == "multipart/alternative" {
			ts, hs = first(ts), first(hs)
		}
		*texts = append(*texts, ts...)
		*htmls = append(*htmls, hs...)
		return
	}

	disposition, dparams, _ := mime.ParseMediaType(h.Get("Content-Disposition"))
	filename := dparams["filename"]
	if filename == "" {
		filename = params["name"]
	}
	filename = decodeHeader(filename)
	cid := ""
	if v := h.Get("Content-Id"); v != "" {
		if id := firstID(v); id != nil {
			cid = *id
		}
	}
	isText := ctype == "text/plain" || ctype == "text/html"
	if isText && disposition != "attachment" && filename == "" {
		s := decodeCharset(params["charset"], data)
		if ctype == "text/plain" {
			*texts = append(*texts, s)
		} else {
			*htmls = append(*htmls, s)
		}
		return
	}
	a := attachment{
		ContentType: ctype,
		Size:        len(data),
		Inline:      disposition == "inline" || (disposition == "" && cid != ""),
		Data:        base64.StdEncoding.EncodeToString(data),
	}
	if filename != "" {
		a.Filename = &filename
	}
	if cid != "" {
		a.ContentID = &cid
	}
	*atts = append(*atts, a)
}

func first(xs []string) []string {
	if len(xs) > 1 {
		return xs[:1]
	}
	return xs
}

// decodeTransfer undoes base64 or quoted-printable; anything else is read as it is. Broken
// base64 gives what decoded before the break, as mail readers do.
func decodeTransfer(encoding string, body io.Reader) []byte {
	raw, _ := io.ReadAll(body)
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\t' || r == '\r' || r == '\n' {
				return -1
			}
			return r
		}, string(raw))
		clean = strings.TrimRight(clean, "=")
		out, err := base64.RawStdEncoding.DecodeString(clean)
		if err != nil {
			// Decode what's there up to the bad character.
			out = make([]byte, base64.RawStdEncoding.DecodedLen(len(clean)))
			n, _ := base64.RawStdEncoding.Decode(out, []byte(clean))
			out = out[:n]
		}
		return out
	case "quoted-printable":
		out, err := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(raw)))
		if err != nil && len(out) == 0 {
			return raw
		}
		return out
	}
	return raw
}

// decodeCharset is text in charset as UTF-8; text in an unknown charset keeps its valid UTF-8,
// the rest replaced.
func decodeCharset(charset string, data []byte) string {
	charset = strings.ToLower(strings.TrimSpace(charset))
	if charset != "" && charset != "utf-8" && charset != "us-ascii" && charset != "utf8" {
		if enc, err := htmlindex.Get(charset); err == nil {
			if out, err := enc.NewDecoder().Bytes(data); err == nil {
				return string(out)
			}
		}
	}
	if utf8.Valid(data) {
		return string(data)
	}
	return strings.ToValidUTF8(string(data), "�")
}

// Compose writes a UTF-8 plain-text message. to and cc are name, address pairs; id is the
// Message-ID without brackets; dateMs its Date.
func Compose(fromName, fromAddress string, to, cc []string, subject, text, inReplyTo string, references []string, id string, dateMs int64) string {
	var b strings.Builder
	header := func(name, value string) {
		b.WriteString(fold(name + ": " + value))
		b.WriteString("\r\n")
	}
	header("From", (&mail.Address{Name: fromName, Address: fromAddress}).String())
	if list := addressList(to); list != "" {
		header("To", list)
	}
	if list := addressList(cc); list != "" {
		header("Cc", list)
	}
	header("Subject", mime.QEncoding.Encode("utf-8", subject))
	header("Date", time.UnixMilli(dateMs).UTC().Format(time.RFC1123Z))
	header("Message-ID", "<"+id+">")
	if inReplyTo != "" {
		header("In-Reply-To", "<"+inReplyTo+">")
	}
	if len(references) > 0 {
		refs := make([]string, len(references))
		for i, r := range references {
			refs[i] = "<" + r + ">"
		}
		header("References", strings.Join(refs, " "))
	}
	header("MIME-Version", "1.0")
	header("Content-Type", "text/plain; charset=utf-8")
	header("Content-Transfer-Encoding", "quoted-printable")
	b.WriteString("\r\n")
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	w := quotedprintable.NewWriter(&b)
	w.Write([]byte(text))
	w.Close()
	return b.String()
}

func addressList(pairs []string) string {
	var parts []string
	for i := 0; i+1 < len(pairs); i += 2 {
		parts = append(parts, (&mail.Address{Name: pairs[i], Address: pairs[i+1]}).String())
	}
	return strings.Join(parts, ", ")
}

// fold breaks a header line longer than 78 characters at spaces, continuing on lines that
// start with a space. A word longer than that stays whole.
func fold(line string) string {
	if len(line) <= 78 {
		return line
	}
	var b strings.Builder
	width := 0
	for i, word := range strings.Split(line, " ") {
		if i > 0 {
			if width+1+len(word) > 78 {
				b.WriteString("\r\n ")
				width = 1
			} else {
				b.WriteString(" ")
				width++
			}
		}
		b.WriteString(word)
		width += len(word)
	}
	return b.String()
}
