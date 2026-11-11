// Command gotypes prints what Candor needs to know about Go packages: their exported functions,
// variables, constants and types (with their methods), with each type sorted into the kinds a
// binding can pass. It runs in a
// Go module that can see the packages (so third-party ones are already required there), and
// prints JSON on stdout.
//
//	gotypes [-docs] <import path>...
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/types"
	"os"
	"strings"

	"golang.org/x/tools/go/packages"
)

// Type is a Go type as a binding sees it. Kind is "int" (any integer type, named or not),
// "float" (float32 or float64, named or not), "string", "bool", "[]string", "[]byte", "error", "context" (context.Context), "any" (the empty
// interface), "named" (a declared type, or a pointer to one: Pkg, Name and Pointer say which) or
// "other"; Text is how Go writes it, qualified by package name.
type Type struct {
	Kind    string `json:"kind"`
	Text    string `json:"text"`
	Pkg     string `json:"pkg,omitempty"`
	Name    string `json:"name,omitempty"`
	Pointer bool   `json:"pointer,omitempty"`
}

type Param struct {
	Name string `json:"name"`
	Type Type   `json:"type"`
}

type Func struct {
	Name string `json:"name"`
	Doc  string `json:"doc,omitempty"`
	// Without the variadic parameter, if there is one: Rest is its element type.
	Params   []Param `json:"params"`
	Results  []Type  `json:"results"`
	Variadic bool    `json:"variadic"`
	Rest     *Type   `json:"rest,omitempty"`
	// How Go writes the signature: func(s string) (int, error).
	Text string `json:"text"`
	// For a method: whether its receiver is a pointer.
	PointerRecv bool `json:"pointerRecv,omitempty"`
}

// TypeDecl is an exported type: Kind is "struct", "interface" or "other". Methods are those of a
// pointer to it (an interface's own, for an interface).
type TypeDecl struct {
	Name    string `json:"name"`
	Doc     string `json:"doc,omitempty"`
	Kind    string `json:"kind"`
	Methods []Func `json:"methods"`
}

type Value struct {
	Name  string `json:"name"`
	Doc   string `json:"doc,omitempty"`
	Type  Type   `json:"type"`
	Const bool   `json:"const"`
}

type Package struct {
	Path   string     `json:"path"`
	Name   string     `json:"name"`
	Errors []string   `json:"errors"`
	Funcs  []Func     `json:"funcs"`
	Values []Value    `json:"values"`
	Types  []TypeDecl `json:"types"`
}

func main() {
	docs := flag.Bool("docs", false, "include doc comments (slower: parses the packages)")
	flag.Parse()
	mode := packages.NeedName | packages.NeedTypes
	if *docs {
		mode |= packages.NeedSyntax
	}
	pkgs, err := packages.Load(&packages.Config{Mode: mode}, flag.Args()...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gotypes:", err)
		os.Exit(1)
	}
	out := []Package{}
	for _, p := range pkgs {
		out = append(out, describe(p))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{"packages": out}); err != nil {
		fmt.Fprintln(os.Stderr, "gotypes:", err)
		os.Exit(1)
	}
}

func describe(p *packages.Package) Package {
	pkg := Package{Path: p.PkgPath, Name: p.Name, Errors: []string{}, Funcs: []Func{}, Values: []Value{}, Types: []TypeDecl{}}
	for _, e := range p.Errors {
		pkg.Errors = append(pkg.Errors, e.Msg)
	}
	if p.Types == nil {
		return pkg
	}
	docs := docComments(p.Syntax)
	qual := func(other *types.Package) string { return other.Name() }
	scope := p.Types.Scope()
	for _, name := range scope.Names() {
		obj := scope.Lookup(name)
		if !obj.Exported() {
			continue
		}
		switch obj := obj.(type) {
		case *types.Func:
			pkg.Funcs = append(pkg.Funcs, describeFunc(name, docs[name], obj.Type().(*types.Signature), qual))
		case *types.TypeName:
			if obj.IsAlias() {
				continue
			}
			t := TypeDecl{Name: name, Doc: docs[name], Kind: "other", Methods: []Func{}}
			var set *types.MethodSet
			switch obj.Type().Underlying().(type) {
			case *types.Struct:
				t.Kind = "struct"
				set = types.NewMethodSet(types.NewPointer(obj.Type()))
			case *types.Interface:
				t.Kind = "interface"
				set = types.NewMethodSet(obj.Type())
			default:
				set = types.NewMethodSet(types.NewPointer(obj.Type()))
			}
			for i := range set.Len() {
				m := set.At(i).Obj().(*types.Func)
				if !m.Exported() {
					continue
				}
				sig := m.Type().(*types.Signature)
				f := describeFunc(m.Name(), docs[name+"."+m.Name()], sig, qual)
				if sig.Recv() != nil {
					_, f.PointerRecv = sig.Recv().Type().(*types.Pointer)
				}
				t.Methods = append(t.Methods, f)
			}
			pkg.Types = append(pkg.Types, t)
		case *types.Var:
			pkg.Values = append(pkg.Values, Value{Name: name, Doc: docs[name], Type: kindOf(obj.Type(), qual)})
		case *types.Const:
			pkg.Values = append(pkg.Values, Value{Name: name, Doc: docs[name], Type: kindOf(obj.Type(), qual), Const: true})
		}
	}
	return pkg
}

func describeFunc(name, doc string, sig *types.Signature, qual types.Qualifier) Func {
	f := Func{Name: name, Doc: doc, Params: []Param{}, Results: []Type{}, Variadic: sig.Variadic(), Text: types.TypeString(sig, qual)}
	for i := range sig.Params().Len() {
		v := sig.Params().At(i)
		if sig.Variadic() && i == sig.Params().Len()-1 {
			rest := kindOf(v.Type().(*types.Slice).Elem(), qual)
			f.Rest = &rest
			break
		}
		f.Params = append(f.Params, Param{Name: v.Name(), Type: kindOf(v.Type(), qual)})
	}
	for i := range sig.Results().Len() {
		f.Results = append(f.Results, kindOf(sig.Results().At(i).Type(), qual))
	}
	return f
}

var errorType = types.Universe.Lookup("error").Type()

func kindOf(t types.Type, qual types.Qualifier) Type {
	text := types.TypeString(t, qual)
	if types.Identical(t, errorType) {
		return Type{Kind: "error", Text: text}
	}
	if n, ok := t.(*types.Named); ok && n.Obj().Pkg() != nil && n.Obj().Pkg().Path() == "context" && n.Obj().Name() == "Context" {
		return Type{Kind: "context", Text: text}
	}
	switch u := t.Underlying().(type) {
	case *types.Basic:
		switch {
		case u.Info()&types.IsInteger != 0 && u.Kind() != types.UntypedRune:
			return Type{Kind: "int", Text: text}
		case u.Info()&types.IsFloat != 0:
			return Type{Kind: "float", Text: text}
		case u.Info()&types.IsString != 0:
			return Type{Kind: "string", Text: text}
		case u.Info()&types.IsBoolean != 0:
			return Type{Kind: "bool", Text: text}
		}
	case *types.Slice:
		if b, ok := u.Elem().(*types.Basic); ok && b.Kind() == types.String {
			return Type{Kind: "[]string", Text: text}
		}
		if b, ok := u.Elem().(*types.Basic); ok && b.Kind() == types.Byte {
			return Type{Kind: "[]byte", Text: text}
		}
	case *types.Interface:
		if u.Empty() {
			return Type{Kind: "any", Text: text}
		}
	}
	pointer := false
	if p, ok := t.(*types.Pointer); ok {
		t, pointer = p.Elem(), true
	}
	if n, ok := t.(*types.Named); ok && n.Obj().Pkg() != nil && n.TypeArgs().Len() == 0 {
		return Type{Kind: "named", Text: text, Pkg: n.Obj().Pkg().Path(), Name: n.Obj().Name(), Pointer: pointer}
	}
	return Type{Kind: "other", Text: text}
}

// The first sentence of each top-level declaration's doc comment, by name.
func docComments(files []*ast.File) map[string]string {
	docs := map[string]string{}
	first := func(g *ast.CommentGroup) string {
		if g == nil {
			return ""
		}
		text := strings.Join(strings.Fields(g.Text()), " ")
		if i := strings.Index(text, ". "); i >= 0 {
			text = text[:i+1]
		}
		return text
	}
	for _, f := range files {
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				if d.Recv == nil {
					docs[d.Name.Name] = first(d.Doc)
				} else if recv := receiverName(d.Recv); recv != "" {
					docs[recv+"."+d.Name.Name] = first(d.Doc)
				}
			case *ast.GenDecl:
				for _, s := range d.Specs {
					if t, ok := s.(*ast.TypeSpec); ok {
						doc := t.Doc
						if doc == nil && len(d.Specs) == 1 {
							doc = d.Doc
						}
						docs[t.Name.Name] = first(doc)
					}
					if v, ok := s.(*ast.ValueSpec); ok {
						doc := v.Doc
						if doc == nil && len(d.Specs) == 1 {
							doc = d.Doc
						}
						for _, n := range v.Names {
							docs[n.Name] = first(doc)
						}
					}
				}
			}
		}
	}
	return docs
}

// The type a method's receiver names, as in `func (db *DB) Query`.
func receiverName(fields *ast.FieldList) string {
	if fields == nil || len(fields.List) == 0 {
		return ""
	}
	t := fields.List[0].Type
	if star, ok := t.(*ast.StarExpr); ok {
		t = star.X
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}
