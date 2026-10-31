package candor

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/url"
	"strings"
)

// FormFile is one file of a posted form: `http.FormFile`.
type FormFile struct {
	Field, Name, ContentType string
	Data                     []byte
}

// Why a form couldn't be read: `http.FormError`'s variants, in order.
const (
	FormNotAForm = iota
	FormTooLarge
	FormMalformed
	FormBroken
)

// FormBoundary is the boundary of the bodies FormBody writes: `http.formRequest`'s.
const FormBoundary = "candor-form-boundary"

type formTooLarge struct{}

// ReadForm reads the form in a request's body: body itself, or the stream id holds when
// streamed, at most max bytes of it. It gives the fields in the order they came, the files, and
// on failure why (a Form* kind) and a message; kind is -1 when it read.
func ReadForm(c *Ctx, body string, streamed bool, id int64, contentType string, max int64) (fields Map[string, []string], files []FormFile, kind int, why string) {
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || (media != "multipart/form-data" && media != "application/x-www-form-urlencoded") {
		return fields, nil, FormNotAForm, contentType
	}
	data := []byte(body)
	if streamed {
		var buf bytes.Buffer
		why, large := readCapped(c, id, max, &buf)
		if large {
			return fields, nil, FormTooLarge, ""
		}
		if why != "" {
			return fields, nil, FormBroken, why
		}
		data = buf.Bytes()
	} else if int64(len(data)) > max {
		return fields, nil, FormTooLarge, ""
	}
	if media == "application/x-www-form-urlencoded" {
		return urlForm(string(data))
	}
	boundary := params["boundary"]
	if boundary == "" {
		return fields, nil, FormMalformed, "no boundary in the content type"
	}
	// The reader takes a body without a boundary in it for an empty form.
	if !bytes.Contains(data, []byte("--"+boundary+"--")) {
		return fields, nil, FormMalformed, "no closing boundary"
	}
	r := multipart.NewReader(bytes.NewReader(data), boundary)
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			return fields, files, -1, ""
		}
		if err != nil {
			return fields, nil, FormMalformed, err.Error()
		}
		content, err := io.ReadAll(part)
		if err != nil {
			return fields, nil, FormMalformed, err.Error()
		}
		if part.FileName() == "" {
			old, _ := fields.Get(part.FormName())
			fields.Set(part.FormName(), append(old[:len(old):len(old)], string(content)))
			continue
		}
		files = append(files, FormFile{Field: part.FormName(), Name: part.FileName(), ContentType: part.Header.Get("Content-Type"), Data: content})
	}
}

// readCapped reads the stream id holds into buf, stopping once it passes max.
func readCapped(c *Ctx, id int64, max int64, buf *bytes.Buffer) (why string, large bool) {
	defer func() {
		if p := recover(); p != nil {
			if _, ok := p.(formTooLarge); !ok {
				panic(p)
			}
			large = true
		}
	}()
	why = ReadBody(c, id, func(_ *Ctx, piece string) {
		if int64(buf.Len()+len(piece)) > max {
			panic(formTooLarge{})
		}
		buf.WriteString(piece)
	})
	return why, false
}

// urlForm reads `a=1&b=2`, keeping the order the keys came in (url.ParseQuery doesn't).
func urlForm(s string) (fields Map[string, []string], files []FormFile, kind int, why string) {
	for _, pair := range strings.Split(s, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		key, err := url.QueryUnescape(k)
		if err != nil {
			return fields, nil, FormMalformed, err.Error()
		}
		value, err := url.QueryUnescape(v)
		if err != nil {
			return fields, nil, FormMalformed, err.Error()
		}
		old, _ := fields.Get(key)
		fields.Set(key, append(old[:len(old):len(old)], value))
	}
	return fields, nil, -1, ""
}

// FormBody is a multipart body holding fields and files, with FormBoundary.
func FormBody(fields Map[string, []string], files []FormFile) string {
	var out bytes.Buffer
	w := multipart.NewWriter(&out)
	w.SetBoundary(FormBoundary)
	for _, e := range fields.Entries() {
		for _, v := range e.Value {
			w.WriteField(e.Key, v)
		}
	}
	for _, f := range files {
		h := make(map[string][]string)
		h["Content-Disposition"] = []string{`form-data; name="` + quoteField(f.Field) + `"; filename="` + quoteField(f.Name) + `"`}
		if f.ContentType != "" {
			h["Content-Type"] = []string{f.ContentType}
		}
		part, _ := w.CreatePart(h)
		part.Write(f.Data)
	}
	w.Close()
	return out.String()
}

func quoteField(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}
