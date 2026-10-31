import type * as ast from './ast';
import { CandorError, Codes, type Diagnostic, type Span } from './diagnostics';
import type { Token, TokenKind } from './lexer';

/**
 * Recursive descent. A syntax error is reported to `diagnostics` and parsing resumes: at the next
 * line of the block for a statement, at the next declaration in column 1 otherwise. What failed
 * is left out of the tree. Null only when the `module` line itself doesn't parse.
 */
export function parse(tokens: Token[], file: string, diagnostics: Diagnostic[]): ast.Module | null {
  // The lexer's errors are already in, and a parse error on their line would repeat them.
  const reported = new Set(diagnostics.filter((d) => d.file === file).map((d) => d.span.start.line));
  return new Parser(tokens, file, diagnostics, reported).module();
}

/** A block that never closes. It ends its declaration, not just a statement. */
class Unclosed extends CandorError {}

const statementWords = new Set(['let', 'return', 'for', 'while', 'defer', 'assert', 'break', 'continue']);
const closers = new Set([')', ']', '}']);
const startsStatement = (t: Token) => t.kind === 'keyword' && statementWords.has(t.text);

/** Declarations start with these: `fn` and `struct`, or `import "`, `effect Name` and the like. */
function declAt(toks: Token[], q: number): boolean {
  const t = toks[q];
  const n = toks[q + 1];
  if (t.kind === 'keyword') return t.text === 'fn' || t.text === 'struct' || t.text === 'enum';
  if (t.kind !== 'ident' || !n) return false;
  if (t.text === 'pub') return declAt(toks, q + 1);
  if (t.text === 'test' && n.kind === 'keyword' && n.text === 'fn') return true;
  if (['import', 'extern', 'test'].includes(t.text)) return n.kind === 'string' || n.kind === 'template';
  if (['effect', 'fake', 'trait', 'const'].includes(t.text)) return n.kind === 'ident';
  return t.text === 'impl' && (n.kind === 'ident' || n.text === '<');
}

class Parser {
  private p = 0;
  /**
   * Set while parsing an `if` condition or `match` subject, where `{` opens the body: there
   * `if p == Point { x: 1 } {` would be ambiguous, so struct literals need parentheses (as in Rust).
   */
  private noStruct = false;
  private readonly dropped: ast.Dropped[] = [];
  private readonly lostItems: string[] = [];

  constructor(
    private readonly toks: Token[],
    private readonly file: string,
    private readonly diagnostics: Diagnostic[],
    private readonly reported: Set<number>,
  ) {}

  module(): ast.Module | null {
    this.skipNewlines();
    let start: Span;
    let name: Token;
    const first = this.p;
    try {
      start = this.expect('keyword', 'module').span;
      name = this.expect('ident');
      this.endStatement();
    } catch (err) {
      this.report(err, first);
      return null;
    }
    // `import` and `extern` are only keywords here, like `test`.
    const imports: ast.ImportDecl[] = [];
    while (this.at('ident', 'import') && this.toks[this.p + 1].kind === 'string') {
      const from = this.p;
      const kw = this.next();
      const path = this.next();
      try {
        const alias = this.accept('ident', 'as') ? this.expect('ident') : undefined;
        imports.push({ kind: 'Import', path: path.text, pathSpan: path.span, alias: alias?.text, aliasSpan: alias?.span, span: this.spanFrom(kw.span) });
        this.endStatement();
      } catch (err) {
        this.report(err, from);
        this.resync(from, 'statement');
      }
    }
    const decls: ast.Decl[] = [];
    const lostNames: string[] = [];
    while (!this.at('eof')) {
      const from = this.p;
      try {
        this.decl(decls);
      } catch (err) {
        this.report(err, from);
        this.resync(from, 'decl');
        lostNames.push(...this.declaredNames(from, this.p));
      }
      this.skipNewlines();
    }
    lostNames.push(...this.lostItems);
    return { kind: 'Module', name: name.text, nameSpan: name.span, imports, decls, lostNames, dropped: this.dropped, span: this.spanFrom(start) };
  }

  private decl(decls: ast.Decl[]) {
    const kw = this.peek();
    if (kw.kind === 'ident' && ['import', 'extern', 'test'].includes(kw.text) && this.toks[this.p + 1].kind === 'template') {
      this.fail(`\`${kw.text}\` takes a fixed string, so it cannot interpolate`, this.toks[this.p + 1].span);
    }
    if (this.at('ident', 'import') && this.toks[this.p + 1].kind === 'string') {
      this.fail('imports come first, right after `module`', this.peek().span, 'move this `import` up');
    }
    // `pub` is only a keyword before a declaration.
    const pub = this.at('ident', 'pub') ? this.next().span : null;
    if (pub && !declAt(this.toks, this.p)) {
      this.fail(`expected a declaration after \`pub\`, found ${describeToken(this.peek())}`, this.peek().span, '`pub` goes before `fn`, `test fn`, `struct`, `enum`, `trait`, `const` or `extern`');
    }
    if (this.at('keyword', 'fn')) decls.push(this.fnDecl(false, pub));
    // `const` too: only before a name.
    else if (this.at('ident', 'const') && this.toks[this.p + 1].kind === 'ident') decls.push(this.constDecl(pub));
    else if (this.at('ident', 'extern') && this.toks[this.p + 1].kind === 'string') decls.push(this.externDecl(pub));
    // `effect` and `fake` too: only before a name.
    else if (this.at('ident', 'effect') && this.toks[this.p + 1].kind === 'ident') {
      this.refusePub(pub, 'an effect', 'its operations are always public: the effect is what the module offers');
      decls.push(this.effectDecl());
    } else if (this.at('ident', 'fake') && this.toks[this.p + 1].kind === 'ident') {
      this.refusePub(pub, 'a fake', "tests that use the effect get its fake, with all of the fake's functions");
      decls.push(this.fakeDecl());
    } else if (this.at('keyword', 'struct')) decls.push(this.structDecl(pub));
    else if (this.at('keyword', 'enum')) decls.push(this.enumDecl(pub));
    // `trait` and `impl` too: only before a name (or `impl<`, to say it isn't there yet).
    else if (this.at('ident', 'trait') && this.toks[this.p + 1].kind === 'ident') decls.push(this.traitDecl(pub));
    else if (this.at('ident', 'impl') && (this.toks[this.p + 1].kind === 'ident' || this.toks[this.p + 1].text === '<')) {
      this.refusePub(pub, 'an `impl`', 'it can be used wherever its trait and its type can');
      decls.push(this.implDecl());
    }
    // `test` is only a keyword here, so it stays usable as a name everywhere else.
    else if (this.at('ident', 'test') && this.toks[this.p + 1].kind === 'string') {
      this.refusePub(pub, 'a test', '`candor test` runs it; nothing calls it');
      decls.push(this.testDecl());
    } else if (this.at('ident', 'test') && this.toks[this.p + 1].kind === 'keyword' && this.toks[this.p + 1].text === 'fn') {
      const test = this.next().span;
      const decl = this.fnDecl(false, pub);
      decls.push({ ...decl, test, span: this.spanFrom(pub ?? test) });
    } else if (this.at('ident', 'async')) this.fail(concurrencyHabits.get('async')![0], this.peek().span, concurrencyHabits.get('async')![1]);
    else {
      this.fail(
        `expected a declaration, found ${describeToken(this.peek())}`,
        this.peek().span,
        'module level allows `fn`, `test fn`, `struct`, `enum`, `trait`, `impl`, `const`, `extern`, `effect`, `fake` and `test` declarations',
      );
    }
  }

  /**
   * `pub` before something that is always as visible as something else. Reported, but the rest
   * parses as if it weren't there.
   */
  private refusePub(pub: Span | null, what: string, help: string) {
    if (!pub) return;
    const at = this.toks.findIndex((t) => t.span === pub);
    this.report(new CandorError([{ code: Codes.SyntaxError, severity: 'error', message: `${what} takes no \`pub\``, help, file: this.file, span: pub }]), at);
  }

  /** `pub` before a member of a trait, impl, effect or fake: refused, and skipped. */
  private memberPub(what: string, help: string) {
    if (this.at('ident', 'pub') && this.toks[this.p + 1].kind !== 'punct') this.refusePub(this.next().span, what, help);
  }

  /** `inEffect`: an effect's own bindings, which only its operations call, so nothing is `pub`. */
  private externDecl(pub: Span | null, inEffect = false): ast.ExternDecl {
    const kw = this.next().span;
    const start = pub ?? kw;
    const goPath = this.next();
    const items: ast.ExternItem[] = [];
    this.list(() => {
      let own: Span | null = null;
      if (this.at('ident', 'pub') && this.toks[this.p + 1].kind !== 'punct') {
        own = this.next().span;
        if (inEffect) this.refusePub(own, "an effect's binding", 'only its operations call it: offer what it does through an operation');
        else if (pub) this.refusePub(own, 'an item of a `pub extern`', 'every item of the block is already `pub`');
      }
      const itemPub = inEffect ? null : (own ?? pub);
      const t = this.peek();
      const unvetted = this.at('ident', 'unvetted') && this.toks[this.p + 1].text === 'fn' ? this.next().span : null;
      if (unvetted || (t.kind === 'keyword' && t.text === 'fn')) {
        this.next();
        let receiver: ast.Param | null = null;
        if (this.accept('punct', '(')) {
          const rname = this.expect('ident');
          this.expect('punct', ':');
          const type = this.typeExpr();
          receiver = { name: rname.text, type, span: this.spanFrom(rname.span) };
          this.expect('punct', ')');
        }
        const goName = this.expect('ident');
        const { ctx, params, spread, returnType, uses, contracts } = this.signature(true);
        if (contracts.length > 0) {
          this.fail(`a binding has no \`${contracts[0].clause}\``, contracts[0].keywordSpan, 'wrap the Go function in a Candor function with the contract, and call that');
        }
        const alias = this.alias(goName);
        items.push({ kind: 'ExternFn', pub: itemPub, goName: goName.text, goNameSpan: goName.span, ...alias, ctx, unvetted, receiver, params, spread, returnType, uses, span: this.spanFrom(t.span) });
      } else if (this.at('ident', 'type') && (this.toks[this.p + 1].kind === 'ident' || this.toks[this.p + 1].text === '*')) {
        this.next();
        const pointer = this.accept('punct', '*') !== null;
        const goName = this.expect('ident');
        const alias = this.alias(goName);
        items.push({ kind: 'ExternType', goName: goName.text, goNameSpan: goName.span, ...alias, pointer, span: this.spanFrom(t.span) });
      } else if (t.kind === 'keyword' && t.text === 'let') {
        this.next();
        const goName = this.expect('ident');
        this.expect('punct', ':');
        const type = this.typeExpr();
        const alias = this.alias(goName);
        items.push({ kind: 'ExternLet', pub: itemPub, goName: goName.text, goNameSpan: goName.span, ...alias, type, span: this.spanFrom(t.span) });
      } else {
        this.fail(`expected \`fn\`, \`let\` or \`type\`, found ${describeToken(t)}`, t.span, 'an `extern` block lists Go functions (`fn`), variables (`let`) and types (`type`)');
      }
    }, { names: (from) => this.itemName(from) });
    const at = goPath.text.lastIndexOf('@');
    const [path, version] = at < 0 ? [goPath.text, null] : [goPath.text.slice(0, at), goPath.text.slice(at + 1)];
    return { kind: 'ExternDecl', pub, goPath: path, goPathSpan: goPath.span, version, items, span: this.spanFrom(start) };
  }

  /** `as name` after an extern item: its Candor name, else the Go name. */
  private alias(goName: Token): { name: string; nameSpan: Span } {
    if (!this.accept('ident', 'as')) return { name: goName.text, nameSpan: goName.span };
    const name = this.expect('ident');
    return { name: name.text, nameSpan: name.span };
  }

  private constDecl(pub: Span | null): ast.ConstDecl {
    const kw = this.next();
    const name = this.expect('ident');
    const type = this.accept('punct', ':') ? this.typeExpr() : null;
    this.expect('punct', '=');
    const value = this.expr();
    this.endStatement();
    return { kind: 'ConstDecl', pub, name: name.text, nameSpan: name.span, type, value, span: this.spanFrom(pub ?? kw.span) };
  }

  /** `method`: in a `trait` or `impl`, where the first parameter may be `self`. */
  private fnDecl(method = false, pub: Span | null = null): ast.FnDecl {
    const kw = this.expect('keyword', 'fn').span;
    const start = pub ?? kw;
    const name = this.expect('ident');
    const typeParams = this.typeParams();
    const { params, returnType, uses, contracts } = this.signature(false, method);
    this.skipNewlines();
    const body = this.block();
    return { kind: 'FnDecl', pub, name: name.text, nameSpan: name.span, typeParams, params, returnType, uses, contracts, body, span: this.spanFrom(start) };
  }

  /** `<T, U: Eq + Ord>` after the name of a function, struct or enum, or after `impl`. */
  private typeParams(): ast.TypeParam[] {
    const params: ast.TypeParam[] = [];
    if (!this.accept('punct', '<')) return params;
    do {
      const name = this.expect('ident');
      const bounds: ast.TypeParam['bounds'] = [];
      if (this.accept('punct', ':')) {
        do bounds.push(this.path());
        while (this.accept('punct', '+'));
      }
      params.push({ name: name.text, span: name.span, bounds });
    } while (this.accept('punct', ','));
    this.expect('punct', '>');
    return params;
  }

  /** `Show` or `geo.Show`. */
  private path(): { name: string; span: Span } {
    const first = this.expect('ident');
    let name = first.text;
    while (this.accept('punct', '.')) name += `.${this.expect('ident').text}`;
    return { name, span: this.spanFrom(first.span) };
  }

  /** `trait Show { fn show(self) -> string }`: signatures, each with an optional default body. */
  private traitDecl(pub: Span | null): ast.TraitDecl {
    const kw = this.next().span;
    const start = pub ?? kw;
    const name = this.expect('ident');
    if (this.at('punct', '<')) this.fail('traits take no type parameters yet', this.peek().span, '`Self`, the type that has the trait, is the only one');
    const methods: ast.TraitMethod[] = [];
    this.members(() => {
      this.memberPub("a trait's method", 'it is as public as the trait: write `pub trait`');
      if (!this.at('keyword', 'fn')) this.fail(`expected \`fn\`, found ${describeToken(this.peek())}`, this.peek().span, 'a trait lists the signatures of its methods');
      const fnStart = this.next().span;
      const m = this.expect('ident');
      const typeParams = this.typeParams();
      const { params, returnType, uses, contracts } = this.signature(false, true);
      if (contracts.length > 0) {
        this.fail(`a trait method has no \`${contracts[0].clause}\` yet`, contracts[0].keywordSpan, 'put the contract on the methods of each `impl`');
      }
      let body: ast.Block | null = null;
      if (this.atAfterNewlines('punct', '{')) {
        this.skipNewlines();
        body = this.block();
      }
      methods.push({ kind: 'TraitMethod', name: m.text, nameSpan: m.span, typeParams, params, returnType, uses, body, span: this.spanFrom(fnStart) });
    });
    return { kind: 'TraitDecl', pub, name: name.text, nameSpan: name.span, methods, span: this.spanFrom(start) };
  }

  /** `impl Show for Point { ... }`, `impl<T: Show> Show for Box<T> { ... }`. */
  private implDecl(): ast.ImplDecl {
    const start = this.next().span;
    const typeParams = this.typeParams();
    const trait = this.path();
    let rule: ast.ImplDecl['rule'] = null;
    let nulls: Span | null = null;
    const extra: ast.ImplDecl['extra'] = [];
    if (this.accept('punct', '(')) {
      do {
        const r = this.expect('ident');
        if (r.text === 'nulls' && !nulls) nulls = r.span;
        else if (r.text !== 'nulls' && !rule) rule = { name: r.text, span: r.span };
        else extra.push({ name: r.text, span: r.span });
      } while (this.accept('punct', ','));
      this.expect('punct', ')');
    }
    if (!this.accept('keyword', 'for')) {
      this.fail(`expected \`for\`, found ${describeToken(this.peek())}`, this.peek().span, `write \`impl ${trait.name} for Type { ... }\``);
    }
    const target = this.typeExpr();
    const via = this.accept('ident', 'via') ? this.typeExpr() : null;
    const fns: ast.FnDecl[] = [];
    let ahead = this.p;
    while (this.toks[ahead].kind === 'newline') ahead++;
    if (!(this.toks[ahead].kind === 'punct' && this.toks[ahead].text === '{')) {
      return { kind: 'ImplDecl', typeParams, trait: trait.name, traitSpan: trait.span, target, fns, derived: true, rule, nulls, extra, via, span: this.spanFrom(start) };
    }
    this.members(() => {
      this.memberPub("an `impl`'s method", 'it can be called wherever the trait and the type can');
      if (!this.at('keyword', 'fn')) this.fail(`expected \`fn\`, found ${describeToken(this.peek())}`, this.peek().span, 'an `impl` gives the methods of its trait');
      fns.push(this.fnDecl(true));
    });
    return { kind: 'ImplDecl', typeParams, trait: trait.name, traitSpan: trait.span, target, fns, derived: false, rule, nulls, extra, via, span: this.spanFrom(start) };
  }

  /** `effect http { ... }`: `extern` blocks, state, operations (`pub fn`) and helpers (`fn`). */
  private effectDecl(): ast.EffectDecl {
    const start = this.next().span;
    const name = this.expect('ident');
    const state: ast.LetStmt[] = [];
    const externs: ast.ExternDecl[] = [];
    const ops: ast.FnDecl[] = [];
    const helpers: ast.FnDecl[] = [];
    this.members(() => {
      const after = this.toks[this.p + 1];
      if (after.text === 'extern') this.memberPub("an effect's `extern`", 'only its operations call it: offer what it does through an operation');
      else if (after.text === 'let') this.memberPub("an effect's state", 'only its operations see it');
      if (this.at('ident', 'pub') && after.text === 'fn') {
        this.next();
        ops.push(this.fnDecl());
      } else if (this.at('ident', 'extern') && this.toks[this.p + 1].kind === 'string') {
        externs.push(this.externDecl(null, true));
      } else if (this.at('keyword', 'fn')) {
        helpers.push(this.fnDecl());
      } else if (this.at('keyword', 'let')) {
        state.push(this.stmt() as ast.LetStmt);
        this.endStatement();
      } else {
        this.fail(
          `expected \`fn\`, \`let\` or \`extern\`, found ${describeToken(this.peek())}`,
          this.peek().span,
          'an effect lists its operations (`pub fn`), their helpers (`fn`), its state (`let`) and the Go they call (`extern`)',
        );
      }
    });
    return { kind: 'EffectDecl', name: name.text, nameSpan: name.span, state, externs, ops, helpers, span: this.spanFrom(start) };
  }

  /** `fake http { ... }`: state (`let`), then functions. */
  private fakeDecl(): ast.FakeDecl {
    const start = this.next().span;
    const name = this.expect('ident');
    const state: ast.LetStmt[] = [];
    const fns: ast.FnDecl[] = [];
    this.members(() => {
      this.memberPub("a fake's function", 'tests that use the effect can call all of them');
      if (this.at('keyword', 'let')) {
        state.push(this.stmt() as ast.LetStmt);
        this.endStatement();
      } else if (this.at('keyword', 'fn')) {
        fns.push(this.fnDecl());
      } else {
        this.fail(`expected \`let\` or \`fn\`, found ${describeToken(this.peek())}`, this.peek().span, 'a fake holds state (`let`) and functions (`fn`)');
      }
    });
    return { kind: 'FakeDecl', name: name.text, nameSpan: name.span, state, fns, span: this.spanFrom(start) };
  }

  /**
   * `{ member member }`: declarations, one after another. A member with a syntax error is left
   * out, and the next line goes on.
   */
  private members(member: () => void) {
    this.skipNewlines();
    const open = this.expect('punct', '{').span;
    this.skipNewlines();
    while (!this.at('punct', '}')) {
      this.unclosedAtDecl(open);
      const from = this.p;
      try {
        member();
      } catch (err) {
        if (err instanceof Unclosed) throw err;
        this.report(err, from);
        this.resync(from, 'statement');
        this.drop(from, this.declaredNames(from, this.p), true);
      }
      this.skipNewlines();
    }
    this.expect('punct', '}');
  }

  /** In a `{` that is still open: the end of the file, or a declaration in column 1, ends it. */
  private unclosedAtDecl(open: Span) {
    const end = this.at('eof') ? 'the end of the file' : this.peek().span.start.col === 1 && declAt(this.toks, this.p) ? `line ${this.peek().span.start.line}` : null;
    if (end) this.unclosed('this `{` is never closed', open, `a \`}\` is missing in this block, or in one inside it, before ${end}`);
  }

  /**
   * Records what a syntax error skipped, tokens `from` up to here. The names of an item (a field,
   * a variant, a method) may be used anywhere, so they are lost names of the module.
   */
  private drop(from: number, names: string[], item = false) {
    let to = this.p - 1;
    while (to > from && this.toks[to].kind === 'newline') to--;
    this.dropped.push({ span: { start: this.toks[from].span.start, end: this.toks[to].span.end }, names });
    if (item) this.lostItems.push(...names);
  }

  /**
   * `(a: int) -> T uses io`, after a function's name. In an `extern`, a bare `ctx` first says
   * the Go function takes a `context.Context`.
   */
  private signature(
    inExtern = false,
    method = false,
  ): { ctx: Span | null; params: ast.Param[]; spread: ast.Param[] | null; returnType: ast.TypeExpr | null; uses: ast.EffectRef[]; contracts: ast.Contract[] } {
    this.expect('punct', '(');
    const params: ast.Param[] = [];
    let spread: ast.Param[] | null = null;
    let ctx: Span | null = null;
    const bare = (name: string) => this.at('ident', name) && !(this.toks[this.p + 1].kind === 'punct' && this.toks[this.p + 1].text === ':');
    if (inExtern && bare('ctx')) {
      ctx = this.next().span;
      this.accept('punct', ',');
    }
    if (bare('self')) {
      const self = this.next();
      if (!method) this.fail('only methods take `self`', self.span, 'methods are declared in a `trait` and given in an `impl`; a function names its parameters with types');
      params.push({ name: 'self', type: { kind: 'TypeName', name: 'Self', args: [], optional: false, span: self.span }, span: self.span });
      this.accept('punct', ',');
    }
    const param = (into: ast.Param[]) => {
      const pname = this.expect('ident');
      this.expect('punct', ':');
      const type = this.typeExpr();
      into.push({ name: pname.text, type, span: this.spanFrom(pname.span) });
    };
    while (!this.at('punct', ')')) {
      const dots = this.accept('punct', '...');
      if (dots) {
        if (!inExtern) this.fail('only a binding has `...`', dots.span, 'a Candor function takes a `List<T>` instead');
        // `...(id: int, body: string)`: the values Go's variadic parameter gets, always last.
        spread = [];
        this.expect('punct', '(');
        while (!this.at('punct', ')')) {
          param(spread);
          if (!this.accept('punct', ',')) break;
        }
        this.expect('punct', ')');
        this.accept('punct', ',');
        if (!this.at('punct', ')')) this.fail('`...(...)` comes last', this.peek().span, "it fills Go's variadic parameter, which is the last one");
        break;
      }
      param(params);
      if (!this.accept('punct', ',')) break;
    }
    this.expect('punct', ')');
    // The signature may continue on following lines: `-> T`, `uses ...`, then `{`.
    const more = (kind: TokenKind, text: string) => {
      if (!this.atAfterNewlines(kind, text)) return false;
      this.skipNewlines();
      return this.accept(kind, text) !== null;
    };
    let returnType: ast.TypeExpr | null = null;
    if (more('punct', '->')) returnType = this.typeExpr();
    const uses: ast.EffectRef[] = [];
    if (more('keyword', 'uses')) {
      for (;;) {
        uses.push(this.effectRef());
        if (!this.accept('punct', ',')) break;
        this.skipNewlines();
      }
    }
    // `requires` and `ensures` are only keywords here.
    const contracts: ast.Contract[] = [];
    for (;;) {
      const clause = ['requires', 'ensures'].find((c) => this.atAfterNewlines('ident', c)) as ast.Contract['clause'] | undefined;
      if (!clause) break;
      this.skipNewlines();
      const kw = this.next();
      const expr = this.withStructs(false, () => this.expr());
      contracts.push({ clause, keywordSpan: kw.span, expr, span: this.spanFrom(kw.span) });
    }
    return { ctx, params, spread, returnType, uses, contracts };
  }

  private testDecl(): ast.TestDecl {
    const start = this.next().span;
    const name = this.next();
    this.skipNewlines();
    const body = this.block();
    return { kind: 'TestDecl', name: name.text, nameSpan: name.span, body, span: this.spanFrom(start) };
  }

  private structDecl(pub: Span | null): ast.StructDecl {
    const doc = this.toks[pub ? this.p - 1 : this.p].doc;
    const kw = this.expect('keyword', 'struct').span;
    const start = pub ?? kw;
    const name = this.expect('ident');
    const typeParams = this.typeParams();
    const fields = this.fieldDecls(true);
    return { kind: 'StructDecl', pub, name: name.text, nameSpan: name.span, typeParams, fields, ...(doc ? { doc } : {}), span: this.spanFrom(start) };
  }

  private enumDecl(pub: Span | null): ast.EnumDecl {
    const kw = this.expect('keyword', 'enum').span;
    const start = pub ?? kw;
    const name = this.expect('ident');
    const typeParams = this.typeParams();
    const variants: ast.VariantDecl[] = [];
    this.list(() => {
      this.memberPub('a variant', 'it is as public as the enum: write `pub enum`');
      const v = this.expect('ident');
      const wire = this.wireName();
      const fields = this.at('punct', '{') ? this.fieldDecls(false) : [];
      variants.push({ name: v.text, nameSpan: v.span, fields, wire, span: this.spanFrom(v.span) });
    }, { names: (from) => this.itemName(from) });
    return { kind: 'EnumDecl', pub, name: name.text, nameSpan: name.span, typeParams, variants, span: this.spanFrom(start) };
  }

  /** A struct's fields may each be `pub`; a variant's are as public as the enum. */
  private fieldDecls(inStruct: boolean): ast.FieldDecl[] {
    const fields: ast.FieldDecl[] = [];
    this.list(() => {
      const doc = this.toks[this.p].doc;
      // `pub: int` is a field named `pub`.
      const pub = this.at('ident', 'pub') && this.toks[this.p + 1].kind === 'ident' ? this.next().span : null;
      if (!inStruct) this.refusePub(pub, "a variant's field", 'it is as public as the enum: write `pub enum`');
      const name = this.expect('ident');
      this.expect('punct', ':');
      const type = this.typeExpr();
      const wire = this.wireName();
      fields.push({ pub: inStruct ? pub : null, name: name.text, nameSpan: name.span, type, wire, ...(doc ? { doc } : {}), span: this.spanFrom(pub ?? name.span) });
    }, { names: (from) => this.itemName(from) });
    return fields;
  }

  /** `as "created_at"` after a field or variant: its name in JSON. */
  private wireName(): { name: string; span: Span } | null {
    if (!(this.at('ident', 'as') && this.toks[this.p + 1].kind === 'string')) return null;
    this.next();
    const s = this.next();
    return { name: s.text, span: s.span };
  }

  /**
   * `{ item, item` newline `item }`: separated by commas or newlines, trailing comma allowed.
   * With `recover`, an item with a syntax error is left out and the next one goes on; `names`
   * gives what it would have declared, and `dropped` is told.
   */
  private list(item: () => void, recover?: { names: (from: number) => string[]; dropped?: () => void }) {
    const open = this.expect('punct', '{').span;
    this.skipNewlines();
    while (!this.at('punct', '}')) {
      if (!recover) {
        if (this.at('eof')) this.fail('expected `}`', this.peek().span);
        this.listItem(item);
        continue;
      }
      this.unclosedAtDecl(open);
      const from = this.p;
      try {
        this.listItem(item);
      } catch (err) {
        if (err instanceof Unclosed) throw err;
        this.report(err, from);
        this.resync(from, 'item');
        this.drop(from, recover.names(from), true);
        recover.dropped?.();
      }
    }
    this.expect('punct', '}');
  }

  private listItem(item: () => void) {
    item();
    // The lexer drops a newline after a trailing `>`, which can end a type: `xs: List<int>`.
    const lineEnded = this.peek().span.start.line > this.prev().span.end.line;
    if (!this.accept('punct', ',') && !this.at('newline') && !this.at('punct', '}') && !lineEnded) {
      this.fail(`expected \`,\` or end of line, found ${describeToken(this.peek())}`, this.peek().span);
    }
    this.skipNewlines();
  }

  /** The name an item of a struct, enum or extern would have declared: its first, after `pub`. */
  private itemName(from: number): string[] {
    for (let q = from; q < this.p; q++) {
      const t = this.toks[q];
      if (t.kind === 'ident' && !['pub', 'unvetted', 'type'].includes(t.text)) return [t.text];
      if (t.kind !== 'ident' && !(t.kind === 'keyword' && ['fn', 'let', 'mut'].includes(t.text))) return [];
    }
    return [];
  }

  private withStructs<R>(allowed: boolean, f: () => R): R {
    const saved = this.noStruct;
    this.noStruct = !allowed;
    try {
      return f();
    } finally {
      this.noStruct = saved;
    }
  }

  private typeExpr(): ast.TypeExpr {
    const start = this.peek().span;
    let t: ast.TypeExpr;
    if (this.accept('punct', '(')) {
      if (this.at('punct', ')')) this.fail('there is no `()` type', { start: start.start, end: this.peek().span.end }, 'write `void`');
      // Grouping, for `(fn() -> int)?`, or a tuple, `(int, string)`.
      t = this.typeExpr();
      if (this.at('punct', ',')) {
        const elems = [t];
        while (this.accept('punct', ',')) elems.push(this.typeExpr());
        this.expect('punct', ')');
        t = { kind: 'TupleType', elems, optional: false, span: this.spanFrom(start) };
      } else {
        this.expect('punct', ')');
      }
    } else if (this.accept('keyword', 'fn')) {
      t = this.fnTypeExpr(start);
    } else {
      let name = this.expect('ident').text;
      // `geo.Point`: a type of an imported module.
      while (this.accept('punct', '.')) name += `.${this.expect('ident').text}`;
      const args: ast.TypeExpr[] = [];
      if (this.accept('punct', '<')) {
        do args.push(this.typeExpr());
        while (this.accept('punct', ','));
        this.expect('punct', '>');
      }
      t = { kind: 'TypeName', name, args, optional: false, span: this.spanFrom(start) };
    }
    if (this.at('punct', '[') && this.toks[this.p + 1].text === ']') {
      this.fail('Candor writes list types as `List<T>`', this.spanFrom(start), `write \`List<${t.kind === 'TypeName' ? t.name : 'T'}>\``);
    }
    const twice = this.accept('punct', '??');
    if (twice) this.fail('a type can be optional only once', twice.span, 'write `T?`');
    if (this.accept('punct', '?')) {
      if (t.optional) this.fail('a type can be optional only once', this.prev().span, 'write `T?`');
      t = { ...t, optional: true, span: this.spanFrom(start) };
    }
    return t;
  }

  /** After `fn`: `(A, B) -> R uses e`. */
  private fnTypeExpr(start: Span): ast.FnTypeExpr {
    this.expect('punct', '(');
    const params: ast.TypeExpr[] = [];
    while (!this.at('punct', ')')) {
      params.push(this.typeExpr());
      if (!this.accept('punct', ',')) break;
    }
    this.expect('punct', ')');
    const returnType = this.accept('punct', '->') ? this.typeExpr() : null;
    const uses: ast.EffectRef[] = [];
    if (this.accept('keyword', 'uses')) {
      uses.push(this.effectRef());
      // `f: fn() uses io, n: int`: a comma followed by `name:` starts the next parameter.
      while (this.at('punct', ',') && this.toks[this.p + 1].kind === 'ident' && this.toks[this.p + 2].text !== ':') {
        this.next();
        uses.push(this.effectRef());
      }
    }
    return { kind: 'FnType', params, returnType, uses, optional: false, span: this.spanFrom(start) };
  }

  private effectRef(): ast.EffectRef {
    const first = this.expect('ident');
    const path = [first.text];
    while (this.accept('punct', '.')) path.push(this.expect('ident').text);
    return { path, span: this.spanFrom(first.span) };
  }

  private block(): ast.Block {
    return this.withStructs(true, () => {
      const start = this.expect('punct', '{').span;
      this.skipNewlines();
      const stmts: ast.Stmt[] = [];
      while (!this.at('punct', '}')) {
        // Bodies are indented: a declaration in column 1 means a `}` is missing.
        this.unclosedAtDecl(start);
        const from = this.p;
        try {
          stmts.push(this.stmt());
          this.endStatement();
        } catch (err) {
          if (err instanceof Unclosed) throw err;
          this.report(err, from);
          this.resync(from, 'statement');
          this.drop(from, this.declaredNames(from, this.p));
        }
      }
      this.expect('punct', '}');
      return { kind: 'Block', stmts, span: this.spanFrom(start) };
    });
  }

  private stmt(): ast.Stmt {
    const t = this.peek();
    if (t.kind === 'keyword' && t.text === 'let') {
      this.next();
      const mutable = this.accept('keyword', 'mut') !== null;
      if (this.at('punct', '(')) {
        const pattern = this.pattern() as ast.TuplePattern;
        if (mutable) this.fail('`let mut` takes one name', pattern.span, 'destructure with `let (a, b) = ...`, then copy what changes: `let mut total = a`');
        const type = this.accept('punct', ':') ? this.typeExpr() : null;
        this.expect('punct', '=');
        const value = this.expr();
        return { kind: 'LetTuple', pattern, type, value, span: this.spanFrom(t.span) };
      }
      const name = this.expect('ident');
      const type = this.accept('punct', ':') ? this.typeExpr() : null;
      this.expect('punct', '=');
      const value = this.expr();
      return { kind: 'Let', mutable, name: name.text, nameSpan: name.span, type, value, span: this.spanFrom(t.span) };
    }
    if (t.kind === 'ident' && (t.text === 'const' || t.text === 'var') && this.toks[this.p + 1].kind === 'ident') {
      if (t.text === 'const') this.fail('`const` goes at module level, outside functions', t.span, 'inside a function, write `let`');
      this.fail('Candor has no `var`', t.span, 'write `let mut`');
    }
    if (t.kind === 'keyword' && t.text === 'for') return this.forStmt();
    if (t.kind === 'keyword' && t.text === 'while') {
      this.next();
      const cond = this.withStructs(false, () => this.expr());
      const body = this.block();
      return { kind: 'While', cond, body, span: this.spanFrom(t.span) };
    }
    if (t.kind === 'keyword' && (t.text === 'break' || t.text === 'continue')) {
      this.next();
      return { kind: t.text === 'break' ? 'Break' : 'Continue', span: t.span };
    }
    if (t.kind === 'keyword' && t.text === 'defer') {
      this.next();
      if (!this.at('punct', '{')) this.fail('`defer` takes a block', this.peek().span, 'write `defer { close(x) }`');
      const body = this.block();
      return { kind: 'Defer', body, span: this.spanFrom(t.span) };
    }
    if (t.kind === 'keyword' && t.text === 'return') {
      this.next();
      const value = this.at('newline') || this.at('punct', '}') || this.at('punct', ',') ? null : this.expr();
      return { kind: 'Return', value, span: this.spanFrom(t.span) };
    }
    if (t.kind === 'keyword' && t.text === 'assert') {
      this.next();
      const expr = this.expr();
      return { kind: 'Assert', expr, span: this.spanFrom(t.span) };
    }
    const expr = this.expr();
    const op = this.peek();
    if (op.kind === 'punct' && assignOps.has(op.text)) {
      this.next();
      const value = this.expr();
      return { kind: 'Assign', target: expr, op: op.text as ast.AssignOp, opSpan: op.span, value, span: this.spanFrom(expr.span) };
    }
    if (op.kind === 'punct' && (op.text === '++' || op.text === '--')) {
      this.fail(`Candor has no \`${op.text}\``, op.span, `write \`${op.text === '++' ? '+= 1' : '-= 1'}\``);
    }
    return { kind: 'ExprStmt', expr, span: expr.span };
  }

  /** `for x in xs { }`, `for i in 0..n { }`, `for (k, v) in m { }`. */
  private forStmt(): ast.ForStmt {
    const start = this.next().span;
    let pattern: ast.TuplePattern | null = null;
    let name: Token | null = null;
    if (this.at('punct', '(')) {
      if (!this.tupleBeforeIn()) {
        this.fail('`for` takes no parentheses', this.peek().span, 'write `for x in xs { ... }`, or `for i in 0..n { ... }` to count');
      }
      pattern = this.pattern() as ast.TuplePattern;
    } else {
      name = this.expect('ident');
    }
    if (!this.accept('keyword', 'in')) {
      this.fail(`expected \`in\`, found ${describeToken(this.peek())}`, this.peek().span, 'write `for x in xs { ... }`');
    }
    let iterable = this.withStructs(false, () => this.expr());
    let end: ast.Expr | null = null;
    // `for i in 0..n` counts without building the list.
    if (iterable.kind === 'Range') {
      end = iterable.end;
      iterable = iterable.start;
    } else if (this.at('punct', '...')) {
      this.fail('a range is written `a..b`', this.peek().span, 'write `0..n`: it counts from 0 up to n - 1');
    }
    const body = this.block();
    if (pattern && end) this.fail('a range gives one number per step', pattern.span, 'write `for i in ...`');
    return { kind: 'For', name: name?.text ?? '', nameSpan: name?.span ?? pattern!.span, pattern, iterable, end, body, span: this.spanFrom(start) };
  }

  /** At a `(` after `for`: whether it is a tuple pattern, `(k, v) in`, rather than C-style parentheses. */
  private tupleBeforeIn(): boolean {
    let depth = 0;
    let comma = false;
    for (let q = this.p; q < this.toks.length; q++) {
      const t = this.toks[q];
      if (t.kind === 'eof' || t.kind === 'newline') return false;
      if (t.kind !== 'punct') continue;
      if (t.text === '(') depth++;
      else if (t.text === ',' && depth === 1) comma = true;
      else if (t.text === ')' && --depth === 0) return comma && this.toks[q + 1]?.kind === 'keyword' && this.toks[q + 1].text === 'in';
    }
    return false;
  }

  /** An expression; `a..b`, a range, binds loosest, as in Rust: `0..n + 1` is `0..(n + 1)`. */
  private expr(): ast.Expr {
    const start = this.binary(0);
    const dots = this.accept('punct', '..');
    if (!dots) return start;
    const end = this.binary(0);
    if (this.at('punct', '..')) this.fail('ranges cannot be chained', this.peek().span, 'write one range, `a..b`');
    return { kind: 'Range', start, end, opSpan: dots.span, span: { start: start.span.start, end: end.span.end } };
  }

  /** Precedence climbing over `binaryLevels`; all operators are left-associative. */
  private binary(minLevel: number): ast.Expr {
    let left = this.unary();
    let lastLevel = -1;
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct') return left;
      if (t.text === '===' || t.text === '!==') {
        const fix = t.text === '===' ? '==' : '!=';
        this.fail(`Candor has no \`${t.text}\`: \`${fix}\` is already strict`, t.span, `use \`${fix}\``);
      }
      const level = binaryLevels.get(t.text);
      if (level === undefined || level < minLevel) return left;
      if (level === lastLevel && nonAssociative.has(level)) {
        this.fail('comparisons cannot be chained', t.span, 'combine them with `&&`, as in `a < b && b < c`');
      }
      this.next();
      const right = this.binary(level + 1);
      left = {
        kind: 'Binary',
        op: t.text as ast.BinaryOp,
        opSpan: t.span,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      lastLevel = level;
    }
  }

  private unary(): ast.Expr {
    const t = this.peek();
    if (t.kind === 'punct' && (t.text === '-' || t.text === '!')) {
      this.next();
      const operand = this.unary();
      return { kind: 'Unary', op: t.text, opSpan: t.span, operand, span: this.spanFrom(t.span) };
    }
    return this.postfix();
  }

  private postfix(): ast.Expr {
    let e = this.primary();
    for (;;) {
      const typeArgs = (e.kind === 'Ident' || e.kind === 'Member') && !e.typeArgs ? this.typeArgs() : null;
      if (typeArgs && (e.kind === 'Ident' || e.kind === 'Member')) {
        e = { ...e, typeArgs, span: this.spanFrom(e.span) };
      } else if (this.accept('punct', '.')) {
        // `pair.0`: a tuple's item by position.
        const name = this.at('int') ? this.next() : this.expect('ident');
        e = { kind: 'Member', object: e, name: name.text, nameSpan: name.span, span: this.spanFrom(e.span) };
      } else if (this.accept('punct', '(')) {
        const args: ast.Expr[] = [];
        this.withStructs(true, () => {
          while (!this.at('punct', ')')) {
            args.push(this.expr());
            if (!this.accept('punct', ',')) break;
          }
        });
        this.expect('punct', ')');
        e = { kind: 'Call', callee: e, args, span: this.spanFrom(e.span) };
      } else if (!this.noStruct && this.at('punct', '{') && typePath(e)) {
        e = this.structLit(e, typePath(e)!);
      } else if (this.at('punct', '[')) {
        const bracket = this.next();
        const index = this.withStructs(true, () => this.expr());
        this.expect('punct', ']');
        e = { kind: 'Index', object: e, index, bracketSpan: bracket.span, span: this.spanFrom(e.span) };
      } else if (this.at('punct', '?')) {
        const q = this.next();
        e = { kind: 'Try', operand: e, opSpan: q.span, span: this.spanFrom(e.span) };
      } else {
        return e;
      }
    }
  }

  /** The expression in a `${ }`, from its own tokens. Struct literals are allowed: braces close it. */
  private interpolated(toks: Token[]): ast.Expr {
    const inner = new Parser(toks, this.file, this.diagnostics, this.reported);
    const e = inner.withStructs(true, () => inner.expr());
    if (!inner.at('eof')) inner.fail(`expected \`}\` to close \`\${\`, found ${describeToken(inner.peek())}`, inner.peek().span);
    return e;
  }

  private primary(): ast.Expr {
    const t = this.next();
    switch (t.kind) {
      case 'string':
        return { kind: 'String', value: t.text, span: t.span };
      case 'template':
        return { kind: 'Interp', parts: t.parts!.map((p) => (typeof p === 'string' ? p : this.interpolated(p))), span: t.span };
      case 'int':
        return { kind: 'Int', value: t.text, span: t.span };
      case 'float':
        return { kind: 'Float', value: t.text, span: t.span };
      case 'char':
        return { kind: 'Char', value: t.text, span: t.span };
      case 'ident': {
        if (this.at('punct', '=>')) {
          this.fail('a lambda needs parentheses around its parameters', t.span, `write \`(${t.text}) => ...\``);
        }
        // Habits from other languages, written as if they were keywords.
        const n = this.peek();
        const operand = n.span.start.line === t.span.start.line && (n.kind === 'ident' || (n.kind === 'punct' && n.text === '(') || (n.kind === 'keyword' && n.text === 'fn'));
        const habit = operand ? concurrencyHabits.get(t.text) : undefined;
        if (habit) this.fail(habit[0], t.span, habit[1]);
        return { kind: 'Ident', name: t.text, span: t.span };
      }
      case 'keyword':
        if (t.text === 'true' || t.text === 'false') return { kind: 'Bool', value: t.text === 'true', span: t.span };
        if (t.text === 'if') return this.ifExpr(t);
        if (t.text === 'match') return this.matchExpr(t);
        if (t.text === 'none') return { kind: 'None', span: t.span };
        break;
      case 'punct':
        if (t.text === '(') {
          if (this.lambdaAhead()) return this.lambda(t);
          if (this.at('punct', ')')) {
            this.fail('Candor has no `()` value', { start: t.span.start, end: this.peek().span.end }, 'a `Result<void, E>` that worked is `Ok()`; a function that returns nothing needs no `return` value');
          }
          const e = this.withStructs(true, () => this.expr());
          if (this.at('punct', ',')) {
            const items = [e];
            this.withStructs(true, () => {
              while (this.accept('punct', ',')) items.push(this.expr());
            });
            this.expect('punct', ')');
            return { kind: 'TupleLit', items, span: this.spanFrom(t.span) };
          }
          this.expect('punct', ')');
          // The expression as written includes its parentheses, so its source can be quoted.
          e.span = this.spanFrom(t.span);
          return e;
        }
        if (t.text === '[') {
          if (this.accept('punct', ':')) {
            this.expect('punct', ']');
            return { kind: 'MapLit', entries: [], span: this.spanFrom(t.span) };
          }
          const items: ast.Expr[] = [];
          const entries: ast.MapLit['entries'] = [];
          this.withStructs(true, () => {
            while (!this.at('punct', ']')) {
              const item = this.expr();
              const keyed = this.accept('punct', ':');
              if (keyed ? items.length > 0 : entries.length > 0) {
                this.fail('a literal is a list or a map, not both', item.span, 'give every item of a map a key: `[k: v, ...]`');
              }
              if (keyed) entries.push({ key: item, value: this.expr() });
              else items.push(item);
              if (!this.accept('punct', ',')) break;
            }
          });
          this.expect('punct', ']');
          if (entries.length > 0) return { kind: 'MapLit', entries, span: this.spanFrom(t.span) };
          return { kind: 'ListLit', items, span: this.spanFrom(t.span) };
        }
        if (t.text === '.' && this.at('ident')) return this.shortVariant(t);
        break;
    }
    return this.fail(`expected an expression, found ${describeToken(t)}`, t.span);
  }

  /**
   * `<int>` after a name, as in `first<int>(xs)`, `Page<int> { ... }` or `Tree<int>.Leaf`, or null
   * if the `<` is a comparison. Comparisons can't chain, so `a < b > (c)` means nothing else.
   */
  private typeArgs(): ast.TypeArgs | null {
    if (!this.at('punct', '<')) return null;
    const saved = this.p;
    try {
      const start = this.next().span;
      const types: ast.TypeExpr[] = [];
      do types.push(this.typeExpr());
      while (this.accept('punct', ','));
      this.expect('punct', '>');
      const n = this.peek();
      if (n.kind === 'punct' && (n.text === '(' || n.text === '.' || (n.text === '{' && !this.noStruct))) return { types, span: this.spanFrom(start) };
    } catch (err) {
      if (!(err instanceof CandorError)) throw err;
    }
    this.p = saved;
    return null;
  }

  /** Just after a `(`: whether its matching `)` is followed by `=>`. */
  private lambdaAhead(): boolean {
    let depth = 1;
    for (let q = this.p; q < this.toks.length; q++) {
      const t = this.toks[q];
      if (t.kind === 'eof') return false;
      if (t.kind !== 'punct') continue;
      if (t.text === '(') depth++;
      else if (t.text === ')' && --depth === 0) {
        if (this.toks[q + 1]?.text === '=>' || this.usesArrowAt(q + 1)) return true;
        // `(x): T =>`, unless it is a map key, `[(a, b): v]`: only a type and `=>` may follow.
        return this.toks[q + 1]?.text === ':' && this.resultTypeAhead(q + 2);
      }
    }
    return false;
  }

  /** Whether a type starts at token `q` and `=>` follows it. */
  private resultTypeAhead(q: number): boolean {
    const saved = this.p;
    try {
      this.p = q;
      this.typeExpr();
      return this.at('punct', '=>') || this.usesArrowAt(this.p);
    } catch (err) {
      if (!(err instanceof CandorError)) throw err;
      return false;
    } finally {
      this.p = saved;
    }
  }

  /** `uses a, b.c =>` at token `q`: effects written on a lambda, which gets its own error. */
  private usesArrowAt(q: number): boolean {
    if (this.toks[q]?.kind !== 'keyword' || this.toks[q].text !== 'uses') return false;
    for (q++; this.toks[q]?.kind === 'ident' || this.toks[q]?.text === '.' || this.toks[q]?.text === ','; q++);
    return this.toks[q]?.text === '=>';
  }

  /** After the `(`: `x, y: int) => body`. */
  private lambda(open: Token): ast.Lambda {
    const params: ast.LambdaParam[] = [];
    while (!this.at('punct', ')')) {
      const name = this.expect('ident');
      const type = this.accept('punct', ':') ? this.typeExpr() : null;
      params.push({ name: name.text, type, span: this.spanFrom(name.span) });
      if (!this.accept('punct', ',')) break;
    }
    this.expect('punct', ')');
    const returnType = this.accept('punct', ':') ? this.typeExpr() : null;
    if (this.at('keyword', 'uses')) {
      this.fail(
        'a lambda does not write its effects',
        this.peek().span,
        'remove `uses ...`: a lambda uses what its body does, and the function around it must allow that. A function type writes them (`fn(string) -> string? uses sql`), and a function taking one can say `uses f` to take on whatever `f` does',
      );
    }
    this.expect('punct', '=>');
    const body = this.at('punct', '{') ? this.block() : this.withStructs(true, () => this.expr());
    return { kind: 'Lambda', params, returnType, body, span: this.spanFrom(open.span) };
  }

  /** After the `.`: `.Paid`, or `.Paid { at }`, a variant of the enum expected where it goes. */
  private shortVariant(dot: Token): ast.StructLit {
    const name = this.next();
    if (!isUpper(name.text)) {
      this.fail(
        `\`.${name.text}\` cannot start an expression`,
        this.spanFrom(dot.span),
        'a method call goes after its object, on the same line or at the start of the next',
      );
    }
    const pathSpan = this.spanFrom(dot.span);
    if (!this.noStruct && this.at('punct', '{')) {
      return { ...this.structLit({ kind: 'Ident', name: name.text, span: pathSpan }, [name.text]), short: true };
    }
    return { kind: 'StructLit', path: [name.text], short: true, pathSpan, spread: null, typeArgs: null, fields: [], span: pathSpan };
  }

  private structLit(typeExpr: ast.Expr, path: string[]): ast.StructLit {
    let spread: ast.Expr | null = null;
    const fields: ast.FieldInit[] = [];
    this.withStructs(true, () =>
      this.list(() => {
        const dots = this.accept('punct', '...');
        if (dots) {
          if (spread !== null || fields.length > 0) {
            this.fail('`...` must come first', dots.span, 'write the copied value first: `{ ...base, field: value }`');
          }
          spread = this.expr();
          return;
        }
        const name = this.expect('ident');
        const value: ast.Expr = this.accept('punct', ':')
          ? this.expr()
          : { kind: 'Ident', name: name.text, span: name.span };
        fields.push({ name: name.text, nameSpan: name.span, value, span: this.spanFrom(name.span) });
      }),
    );
    return { kind: 'StructLit', path, short: false, pathSpan: typeExpr.span, spread, typeArgs: typeArgsIn(typeExpr), fields, span: this.spanFrom(typeExpr.span) };
  }

  private matchExpr(keyword: Token): ast.Match {
    const subject = this.withStructs(false, () => this.expr());
    const arms: ast.Arm[] = [];
    let dropped = false;
    this.withStructs(true, () =>
      this.list(() => {
        const patterns = [this.pattern()];
        while (this.accept('punct', '|')) patterns.push(this.pattern());
        const patternSpan = { start: patterns[0].span.start, end: patterns.at(-1)!.span.end };
        this.expect('punct', '=>');
        const body = this.armBody();
        arms.push({ patterns, patternSpan, body, span: this.spanFrom(patternSpan) });
      }, { names: () => [], dropped: () => (dropped = true) }),
    );
    return { kind: 'Match', keywordSpan: keyword.span, subject, arms, dropped, span: this.spanFrom(keyword.span) };
  }

  /** `=> expr`, `=> return x` or `=> { ... }`, always as a block. */
  private armBody(): ast.Block {
    if (this.at('punct', '{')) return this.block();
    const start = this.peek().span;
    const stmt = this.stmt();
    if (stmt.kind === 'Let') this.fail('a `let` in a match arm needs braces', stmt.span, 'write `=> { let ... }`');
    return { kind: 'Block', stmts: [stmt], span: this.spanFrom(start) };
  }

  private pattern(): ast.Pattern {
    const t = this.peek();
    if (t.kind === 'ident' && t.text === '_') {
      this.next();
      return { kind: 'Wildcard', span: t.span };
    }
    if (t.kind === 'keyword' && t.text === 'none') {
      this.next();
      return { kind: 'None', span: t.span };
    }
    if (t.kind === 'ident' && this.toks[this.p + 1]?.text === '(') {
      if (t.text === 'Some') {
        this.fail('there is no `Some`', t.span, 'on a `T?`, any pattern but `none` and `_` matches a present value: write `x`, not `Some(x)`');
      }
      if (t.text === 'Ok' || t.text === 'Err') {
        this.next();
        const open = this.expect('punct', '(');
        // `Ok()`: a Result<void, E> that succeeded.
        const bare = t.text === 'Ok' && this.at('punct', ')');
        const inner: ast.Pattern = bare ? { kind: 'Wildcard', span: open.span } : this.pattern();
        this.expect('punct', ')');
        return { kind: 'Result', variant: t.text, inner, bare, span: this.spanFrom(t.span) };
      }
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.next();
      const items: ast.Pattern[] = [];
      do items.push(this.pattern());
      while (this.accept('punct', ','));
      this.expect('punct', ')');
      if (items.length < 2) this.fail('parentheses in a pattern make a tuple, of two or more parts', this.spanFrom(t.span), 'leave them out');
      return { kind: 'Tuple', items, span: this.spanFrom(t.span) };
    }
    const isLiteral =
      t.kind === 'string' ||
      t.kind === 'int' ||
      t.kind === 'char' ||
      (t.kind === 'keyword' && (t.text === 'true' || t.text === 'false')) ||
      (t.kind === 'punct' && t.text === '-');
    if (isLiteral) {
      const negative = this.accept('punct', '-') !== null;
      const value = this.primary();
      if (value.kind !== 'String' && value.kind !== 'Int' && value.kind !== 'Bool' && value.kind !== 'Char') {
        return this.fail('expected a pattern', value.span);
      }
      if (negative && value.kind !== 'Int') this.fail('only numbers can be negative', value.span);
      return { kind: 'Literal', value, negative, span: this.spanFrom(t.span) };
    }
    if (t.kind === 'template') this.fail('a pattern matches a fixed string, so it cannot interpolate', t.span, 'compare with `==` in an `if` instead');
    if (t.kind === 'float') this.fail('a pattern cannot be a float: a computed float rarely equals one exactly', t.span, 'compare with `<` or `>=` in an `if` instead');
    const short = this.accept('punct', '.') !== null;
    const first = this.expect('ident');
    const path = [first.text];
    while (!short && this.accept('punct', '.')) path.push(this.expect('ident').text);
    const pathSpan = this.spanFrom(t.span);
    // Types are uppercase, so a lone lowercase name binds a variable.
    if (!short && path.length === 1 && !isUpper(first.text) && !this.at('punct', '{')) {
      return { kind: 'Binding', name: first.text, span: first.span };
    }
    const fields: ast.FieldPattern[] = [];
    if (this.at('punct', '{')) {
      this.list(() => {
        const dots = this.accept('punct', '..') ?? this.accept('punct', '...');
        if (dots) this.fail(`Candor patterns have no \`${dots.text}\``, dots.span, 'leave out the fields you do not need, or write `_` for them: `.Bad { why, _ }`');
        const name = this.expect('ident');
        // #a64e87fe: `.Bad { _ }`, `.Bad { why, _ }`: the fields not named are ignored, as when left out.
        if (name.text === '_' && !this.at('punct', ':')) return;
        const pattern: ast.Pattern = this.accept('punct', ':')
          ? this.pattern()
          : { kind: 'Binding', name: name.text, span: name.span };
        fields.push({ name: name.text, nameSpan: name.span, pattern, span: this.spanFrom(name.span) });
      });
    }
    return { kind: 'Ctor', path, short, pathSpan, fields, span: this.spanFrom(t.span) };
  }

  private ifExpr(keyword: Token): ast.If {
    const cond = this.withStructs(false, () => this.expr());
    const then = this.block();
    let otherwise: ast.Block | ast.If | null = null;
    // `else` may start the next line: it cannot begin a statement, so this is unambiguous.
    if (this.atAfterNewlines('keyword', 'else')) {
      this.skipNewlines();
      this.next();
      otherwise = this.at('keyword', 'if') ? this.ifExpr(this.next()) : this.block();
    }
    return { kind: 'If', keywordSpan: keyword.span, cond, then, else: otherwise, span: this.spanFrom(keyword.span) };
  }

  private atAfterNewlines(kind: TokenKind, text: string): boolean {
    let q = this.p;
    while (this.toks[q].kind === 'newline') q++;
    return this.toks[q].kind === kind && this.toks[q].text === text;
  }

  /** A statement ends at a newline, or just before the `}` that closes its block. */
  private endStatement() {
    if (this.at('newline')) {
      this.skipNewlines();
      return;
    }
    if (this.at('punct', '}') || this.at('eof')) return;
    // After a `(` left open the lexer gives no newlines, but `let` starting a line can't go on
    // an expression.
    if (startsStatement(this.peek()) && this.peek().span.start.line > this.prev().span.end.line) return;
    this.fail(`expected end of line, found ${describeToken(this.peek())}`, this.peek().span);
  }

  private peek(): Token {
    return this.toks[this.p];
  }

  private prev(): Token {
    return this.toks[this.p - 1];
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.p++;
    return t;
  }

  private at(kind: TokenKind, text?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (text === undefined || t.text === text);
  }

  private accept(kind: TokenKind, text?: string): Token | null {
    return this.at(kind, text) ? this.next() : null;
  }

  private expect(kind: TokenKind, text?: string): Token {
    if (this.at(kind, text)) return this.next();
    const t = this.peek();
    const wanted = text !== undefined ? `\`${text}\`` : describeKind(kind);
    return this.fail(`expected ${wanted}, found ${describeToken(t)}`, t.span);
  }

  private skipNewlines() {
    while (this.at('newline')) this.p++;
  }

  private spanFrom(start: Span): Span {
    return { start: start.start, end: this.prev().span.end };
  }

  private fail(message: string, span: Span, help?: string): never {
    // Card 148: `x!`, as Rust, Kotlin and TypeScript unwrap, wherever it stops the parse.
    if (help === undefined && this.at('punct', '!') && span === this.peek().span && this.p > 0 && endsValue(this.prev())) help = BANG;
    throw new CandorError([{ code: Codes.SyntaxError, severity: 'error', message, help, file: this.file, span }]);
  }

  private unclosed(message: string, span: Span, help?: string): never {
    throw new Unclosed([{ code: Codes.SyntaxError, severity: 'error', message, help, file: this.file, span }]);
  }

  /**
   * One error per bad line: an error in what started at token `from` is left out when one was
   * already reported between there and it, by the lexer or by a block inside it that recovered.
   */
  private report(err: unknown, from: number) {
    if (!(err instanceof CandorError)) throw err;
    for (const d of err.diagnostics) {
      const first = err instanceof Unclosed ? d.span.start.line : this.toks[from].span.start.line;
      let seen = false;
      for (let line = first; line <= d.span.start.line; line++) seen ||= this.reported.has(line);
      if (seen) continue;
      this.diagnostics.push(d);
      this.reported.add(d.span.start.line);
    }
  }

  /**
   * After an error in what started at token `from`: skips to the next line of the same block, or
   * to the `}` closing it, for a statement; for an item of a list, to its `,` too; to the next
   * declaration in column 1 for a declaration. A statement or item stops early at such a
   * declaration too, so the block can say its `}` is missing.
   */
  private resync(from: number, what: 'statement' | 'item' | 'decl') {
    const failed = this.p;
    const open: string[] = [];
    let q = from;
    for (; this.toks[q].kind !== 'eof'; q++) {
      const t = this.toks[q];
      if (q > from && t.span.start.col === 1 && declAt(this.toks, q)) break;
      if (what === 'decl') continue;
      // A newline right inside a `(` means the lexer found it never closed (see `lex`).
      const ends = t.kind === 'newline' ? open.at(-1) !== '{' : what === 'item' && t.text === ',' && open.length === 0;
      if (ends && q >= failed) {
        q++;
        break;
      }
      // An item ends with its line, even where the lexer left out the newline (after `List<T>`),
      // and with a `(` left open, at a line starting in its column.
      const newLine = q > failed && t.span.start.line > this.toks[q - 1].span.end.line;
      if (what === 'item' && newLine && (open.length === 0 || (t.span.start.col === this.toks[from].span.start.col && !closers.has(t.text)))) break;
      // Newlines inside `( )` and `[ ]` aren't tokens: one left open ends at a line that starts
      // a statement.
      if (q > failed && (open.at(-1) === '(' || open.at(-1) === '[') && t.span.start.line > this.toks[q - 1].span.end.line && startsStatement(t)) break;
      if (t.kind !== 'punct') continue;
      if (t.text === '(' || t.text === '[' || t.text === '{') open.push(t.text);
      else if (t.text === ')' || t.text === ']') {
        if (open.at(-1) === (t.text === ')' ? '(' : '[')) open.pop();
      } else if (t.text === '}') {
        // Not ours to skip, if it closes the block (or a bracket left open closes with it).
        if (open.at(-1) !== '{') break;
        open.pop();
      }
    }
    this.p = q;
    this.skipNewlines();
  }

  /** The names a dropped declaration, tokens `from` to `to`, would have declared. */
  private declaredNames(from: number, to: number): string[] {
    const names: string[] = [];
    for (let q = from + 1; q < to; q++) {
      const before = this.toks[q - 1];
      const t = this.toks[q];
      if (t.kind !== 'ident') continue;
      if (before.kind === 'keyword' && ['fn', 'struct', 'enum', 'let', 'mut'].includes(before.text)) names.push(t.text);
      else if (before.kind === 'ident' && ['effect', 'trait', 'type', 'as', 'const'].includes(before.text)) names.push(t.text);
    }
    return names;
  }
}

const isUpper = (name: string) => /^[A-Z]/.test(name);

/**
 * `Point` or `Status.Paid` in front of `{` starts a struct literal, and so do `geo.Point` and
 * `geo.Status.Paid`, from an imported module. Type names are uppercase, module names aren't.
 */
function typePath(e: ast.Expr): string[] | null {
  const path: string[] = [];
  let at = e;
  while (at.kind === 'Member') {
    path.unshift(at.name);
    at = at.object;
  }
  if (at.kind !== 'Ident') return null;
  path.unshift(at.name);
  const types = isUpper(path[0]) ? path : path.slice(1);
  return types.length >= 1 && types.length <= 2 && types.every(isUpper) ? path : null;
}

/** The type arguments written in a type path, `Tree<int>.Node`, with the segment they follow. */
function typeArgsIn(e: ast.Expr): (ast.TypeArgs & { at: number }) | null {
  const chain: (ast.Ident | ast.Member)[] = [];
  let at = e;
  while (at.kind === 'Member') {
    chain.unshift(at);
    at = at.object;
  }
  if (at.kind === 'Ident') chain.unshift(at);
  const i = chain.findIndex((x) => x.typeArgs);
  return i < 0 ? null : { ...chain[i].typeArgs!, at: i };
}

// Same order as TypeScript, loosest first.
const binaryLevels = new Map<string, number>([
  ['??', 1],
  ['||', 2],
  ['&&', 3],
  ['==', 4],
  ['!=', 4],
  ['<', 5],
  ['<=', 5],
  ['>', 5],
  ['>=', 5],
  ['+', 6],
  ['-', 6],
  ['*', 7],
  ['/', 7],
  ['%', 7],
]);

const assignOps = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

/** `await f()`, `async fn`, `go f()`: concurrency the way other languages spell it. */
const concurrencyHabits = new Map<string, [string, string]>([
  ['await', ['Candor has no `await`', 'calls wait for their result already; to run things at the same time, use `tasks.scope` or `tasks.all`']],
  ['async', ['Candor has no `async`', 'no function is async: calls wait for their result, and `uses tasks` runs things at the same time']],
  ['go', ['Candor has no `go` statement', 'spawn the work in a scope, which waits for it: `tasks.scope((s) => { s.spawn(() => f()) })`']],
]);

/** Equality and comparison: `a < b < c` is an error, not `(a < b) < c`. */
const nonAssociative = new Set([4, 5]);

function describeKind(kind: TokenKind): string {
  switch (kind) {
    case 'ident':
      return 'a name';
    case 'string':
      return 'a string';
    case 'int':
      return 'a number';
    case 'newline':
      return 'end of line';
    case 'eof':
      return 'end of file';
    default:
      return kind;
  }
}

const BANG = 'Candor has no `!` to unwrap: give a default with `x ?? 0`, handle `none` with `if x == none { ... }` or `match`, or pass an error on with `?`';

/** Whether `t` can end a value, so a `!` after it is a postfix unwrap, not `!=` or a `not`. */
function endsValue(t: Token): boolean {
  return t.kind === 'ident' || t.kind === 'int' || t.kind === 'string' || (t.kind === 'punct' && (t.text === ')' || t.text === ']'));
}

function describeToken(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return 'end of file';
    case 'newline':
      return 'end of line';
    case 'string':
      return 'a string literal';
    case 'template':
      return 'a string with `${ }` in it';
    case 'int':
    case 'float':
      return `the number ${t.text}`;
    default:
      return `\`${t.text}\``;
  }
}
