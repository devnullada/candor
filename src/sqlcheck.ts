// SQL checked against the schema the program's own migrations make (card 064). The DDL in its
// `sql.exec` calls (`CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `DROP TABLE`) gives the
// tables; each query on one table is then checked: its table and columns exist, its `${}`
// values fit their columns, and the row type it reads into matches what it selects. SQL this
// doesn't understand (recursive WITH, table-valued functions) is left unchecked, with a note.

/** What a column holds, as Candor reads it. `other`: NUMERIC, or no type; nothing is checked. */
export type SqlType = 'int' | 'string' | 'bool' | 'float' | 'bytes' | 'other';

/** `an int`, `a string`, `Bytes`: a type in a message. */
const typeName = (t: SqlType | 'none') => (t === 'int' ? 'an int' : t === 'bytes' ? 'Bytes' : `a ${t}`);

/** Text and Bytes don't mix (card 090): how to go from one to the other. */
const textOrBytes = (from: SqlType | 'none', to: SqlType) =>
  from === 'bytes' && to === 'string'
    ? 'a TEXT column holds strings: store `b.toText()` if the bytes are UTF-8, or make the column BLOB in a migration'
    : from === 'string' && to === 'bytes'
      ? 'a BLOB column holds Bytes: store `s.toBytes()`, or make the column TEXT in a migration'
      : undefined;

export interface SqlColumn {
  name: string;
  type: SqlType;
  /** Can hold NULL: no NOT NULL, not the primary key. */
  nullable: boolean;
  /** An INSERT must give it: NOT NULL, no DEFAULT, not an INTEGER PRIMARY KEY (which numbers itself). */
  required: boolean;
  /** Card 142: there to name, not in `*` or an INSERT without columns: `rowid`, fts5's `rank`. */
  hidden?: boolean;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  /** The `file:line` of the migration that made it, for messages; '' for a query read as a table, or one SQLite has. */
  where: string;
  /** Card 142: SQLite's own (`sqlite_schema`, `pragma_user_version`). */
  builtin?: boolean;
  /** Card 142: a virtual table whose columns the check doesn't know, and why. */
  opaque?: string;
}

/** Tables by lowercase name. */
export type Schema = Map<string, SqlTable>;

/** A `${}` value: its type, and whether it is a `T?` (`none` is NULL). */
export interface SqlParam {
  type: SqlType | 'none';
  optional: boolean;
}

/** What a query reads into: a struct's fields by name, or one column. */
export type RowShape =
  | { kind: 'struct'; name: string; fields: { name: string; type: SqlType; optional: boolean }[] }
  | { kind: 'one'; type: SqlType; optional: boolean };

export interface SqlProblem {
  message: string;
  help?: string;
  /** Not an error: the query isn't checked. */
  note?: boolean;
}

/** A token; `at` and `end` are where it is in the text. A `sub` is a whole `(SELECT ...)`, its tokens in `inner`. */
type Tok = { k: 'word' | 'quoted' | 'num' | 'str' | 'param' | 'punct' | 'sub'; v: string; param?: number; at: number; end: number; inner?: Tok[] };

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let params = 0;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    const start = i;
    const n = out.length;
    if (/\s/.test(c)) {
      i++;
    } else if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      out.push({ k: 'word', v: sql.slice(i, j) } as Tok);
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9.eE]/.test(sql[j])) j++;
      out.push({ k: 'num', v: sql.slice(i, j) } as Tok);
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === "'" && sql[j + 1] === "'") j++;
        else if (sql[j] === "'") break;
      }
      out.push({ k: 'str', v: sql.slice(i + 1, j) } as Tok);
      i = j + 1;
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const j = sql.indexOf(close, i + 1);
      const end = j < 0 ? sql.length : j;
      out.push({ k: 'quoted', v: sql.slice(i + 1, end) } as Tok);
      i = end + 1;
    } else if (c === '?') {
      out.push({ k: 'param', v: '?', param: params++ } as Tok);
      i++;
    } else {
      const two = sql.slice(i, i + 2);
      const p = ['<=', '>=', '<>', '!=', '==', '||'].includes(two) ? two : c;
      out.push({ k: 'punct', v: p } as Tok);
      i += p.length;
    }
    if (out.length > n) Object.assign(out[n], { at: start, end: i });
  }
  return out;
}

const upper = (t: Tok | undefined) => (t?.k === 'word' ? t.v.toUpperCase() : '');
/** The columns `*` gives: not the hidden ones. */
const shown = (table: SqlTable) => table.columns.filter((c) => !c.hidden);
const isName = (t: Tok | undefined) => t !== undefined && (t.k === 'word' || t.k === 'quoted');

/** A table's name at `i`, `t` or `vault.t` (an attached database's, card 134; `main.t` is `t`), and the index after it. */
function tableName(s: Tok[], i: number): { name: string; next: number } | null {
  if (!isName(s[i])) return null;
  if (isP(s[i + 1], '.') && isName(s[i + 2])) return { name: s[i].v.toLowerCase() === 'main' ? s[i + 2].v : `${s[i].v}.${s[i + 2].v}`, next: i + 3 };
  return { name: s[i].v, next: i + 1 };
}

/** `secrets` of `vault.secrets`: what the table goes by in a query. */
const bare = (name: string) => name.slice(name.lastIndexOf('.') + 1);

/** The table `name` names: its own, else for a bare name the one attached table of that name, as SQLite looks it up. */
function findTable(schema: Schema, name: string): SqlTable | undefined {
  const own = schema.get(name.toLowerCase());
  if (own || name.includes('.')) return own;
  const attached = [...schema.values()].filter((t) => bare(t.name).toLowerCase() === name.toLowerCase());
  return attached.length === 1 ? attached[0] : undefined;
}

/** Statements, split at top-level `;`. */
function statements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === 'punct' && t.v === ';') out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length > 0);
}

/** Splits `toks` at commas not inside parentheses. */
function commaSplit(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'punct' && t.v === '(') depth++;
    if (t.k === 'punct' && t.v === ')') depth--;
    if (depth === 0 && t.k === 'punct' && t.v === ',') out.push([]);
    else out[out.length - 1].push(t);
  }
  return out;
}

/** The tokens inside the parentheses that open at `from`, and the index after the close. */
function group(toks: Tok[], from: number): { inner: Tok[]; next: number } | null {
  if (toks[from]?.k !== 'punct' || toks[from].v !== '(') return null;
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    if (toks[i].k === 'punct' && toks[i].v === '(') depth++;
    if (toks[i].k === 'punct' && toks[i].v === ')' && --depth === 0) return { inner: toks.slice(from + 1, i), next: i + 1 };
  }
  return null;
}

/** SQLite's type affinity, from the declared type's words; BOOLEAN is Candor's own. */
function affinity(words: string): SqlType {
  const w = words.toUpperCase();
  if (w.includes('BOOL')) return 'bool';
  if (w.includes('INT')) return 'int';
  if (w.includes('CHAR') || w.includes('CLOB') || w.includes('TEXT')) return 'string';
  if (w.includes('BLOB')) return 'bytes';
  if (w.includes('REAL') || w.includes('FLOA') || w.includes('DOUB')) return 'float';
  return 'other';
}

const constraintWords = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS']);

/** A column definition's declared type, `VARCHAR` of `name VARCHAR(20) NOT NULL`, and the index after its words. */
function declared(def: Tok[]): { words: string[]; next: number } {
  let i = 1;
  const words: string[] = [];
  while (i < def.length && def[i].k === 'word' && !constraintWords.has(upper(def[i]))) words.push(def[i++].v);
  return { words, next: i };
}

// Card 143: declared types that SQLite gives NUMERIC affinity, as it does every name without
// INT, CHAR, CLOB, TEXT, BLOB, REAL, FLOA or DOUB, and that are meant as numbers or dates.
const numericTypes = new Set(['NUMERIC', 'DECIMAL', 'NUMBER', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'MONEY', 'ANY']);

function columnDef(def: Tok[]): SqlColumn | null {
  if (!isName(def[0])) return null;
  const { words: typeWords, next } = declared(def);
  let i = next;
  // `VARCHAR(20)`: the size says nothing Candor checks.
  const sized = group(def, i);
  if (sized) i = sized.next;
  const rest = def.slice(i).map(upper);
  const has = (a: string, b?: string) => rest.some((w, j) => w === a && (b === undefined || rest[j + 1] === b));
  const type = affinity(typeWords.join(' '));
  const primary = has('PRIMARY', 'KEY');
  const notNull = has('NOT', 'NULL');
  const rowid = primary && typeWords.join(' ').toUpperCase() === 'INTEGER';
  return { name: def[0].v, type, nullable: !notNull && !primary, required: notNull && !has('DEFAULT') && !rowid };
}

/** Card 142: a rowid table's `rowid` and its other names, unless a column takes the name. */
function withRowid(columns: SqlColumn[]) {
  for (const name of ['rowid', '_rowid_', 'oid']) {
    if (!columns.some((c) => c.name.toLowerCase() === name)) columns.push({ name, type: 'int', nullable: false, required: false, hidden: true });
  }
}

/**
 * Card 142: `CREATE VIRTUAL TABLE name USING module(args)`. fts5's columns are the arguments
 * without `=` (options), untyped and nullable, plus the hidden column named after the table
 * (`search MATCH ?`) and `rank`; rtree's are an int id and float bounds (`rtree_i32`: ints), `+aux`
 * columns untyped. Other modules' columns aren't known.
 */
function virtualTable(name: string, module: string, args: Tok[], where: string): SqlTable {
  const m = module.toLowerCase();
  const defs = args.length === 0 ? [] : commaSplit(args).filter((a) => !a.some((t) => isP(t, '=')));
  const hidden = (n: string, type: SqlType, nullable: boolean): SqlColumn => ({ name: n, type, nullable, required: false, hidden: true });
  if (m === 'fts5') {
    const columns: SqlColumn[] = defs.filter((d) => isName(d[0])).map((d) => ({ name: d[0].v, type: 'other', nullable: true, required: false }));
    columns.push(hidden(bare(name), 'other', true), hidden('rank', 'float', true));
    withRowid(columns);
    return { name, columns, where };
  }
  if (m === 'rtree' || m === 'rtree_i32') {
    const columns: SqlColumn[] = [];
    for (const d of defs) {
      const aux = isP(d[0], '+');
      const n = aux ? d[1] : d[0];
      if (!isName(n)) continue;
      const type: SqlType = aux ? 'other' : columns.length === 0 || m === 'rtree_i32' ? 'int' : 'float';
      columns.push({ name: n.v, type, nullable: aux, required: false });
    }
    withRowid(columns);
    return { name, columns, where };
  }
  return { name, columns: [], where, opaque: `\`${bare(name)}\` is a ${module} virtual table, whose columns the check doesn't know` };
}

/** Card 142: what SQLite's own tables give: its schema table, and pragmas read as tables. */
function builtinTable(name: string): SqlTable | undefined {
  const n = bare(name).toLowerCase();
  const col = (c: string, type: SqlType, nullable = false): SqlColumn => ({ name: c, type, nullable, required: false });
  if (['sqlite_schema', 'sqlite_master', 'sqlite_temp_schema', 'sqlite_temp_master'].includes(n)) {
    return { name, where: '', builtin: true, columns: [col('type', 'string'), col('name', 'string'), col('tbl_name', 'string'), col('rootpage', 'int'), col('sql', 'string', true)] };
  }
  const pragma = /^pragma_(\w+)$/.exec(n)?.[1];
  if (!pragma) return undefined;
  const ints = ['user_version', 'application_id', 'schema_version', 'data_version', 'page_count', 'page_size', 'freelist_count', 'foreign_keys', 'busy_timeout', 'cache_size'];
  const strings = ['journal_mode', 'encoding', 'locking_mode'];
  if (ints.includes(pragma) || strings.includes(pragma)) return { name, where: '', builtin: true, columns: [col(pragma, ints.includes(pragma) ? 'int' : 'string')] };
  return { name, where: '', columns: [], opaque: `the check doesn't know the columns of \`${bare(name)}\`` };
}

/**
 * Problems with a migration itself: a virtual table module the runtime's SQLite doesn't have
 * (card 142); a column type SQLite reads as a number though it names text (card 143).
 */
export function checkDdl(text: string): SqlProblem[] {
  const problems: SqlProblem[] = [];
  const typeOf = (def: Tok[]) => {
    const words = declared(def).words;
    const type = words.join(' ');
    if (!isName(def[0]) || words.length === 0 || affinity(type) !== 'other' || numericTypes.has(type.toUpperCase())) return;
    problems.push({
      message: `\`${def[0].v} ${type}\`: SQLite reads ${type} as NUMERIC, so text that looks like a number ("50") is stored and read back as one`,
      help: `write \`${def[0].v} TEXT\` for text; a type name SQLite reads as text has TEXT, CHAR or CLOB in it`,
    });
  };
  for (const s of statements(tokenize(text))) {
    const w = s.map(upper);
    if (w[0] === 'CREATE' && w.slice(0, 3).includes('TABLE') && w[1] !== 'VIRTUAL') {
      const body = group(s, s.findIndex((t) => isP(t, '(')));
      for (const def of body ? commaSplit(body.inner) : []) if (!['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(upper(def[0]))) typeOf(def);
    } else if (w[0] === 'ALTER' && w[1] === 'TABLE') {
      const add = w.indexOf('ADD');
      if (add > 0) typeOf(s.slice(w[add + 1] === 'COLUMN' ? add + 2 : add + 1));
    }
    const using = w.indexOf('USING');
    if (w[0] !== 'CREATE' || w[1] !== 'VIRTUAL' || using < 0) continue;
    const module = s[using + 1]?.v ?? '';
    if (/^fts[34]$/i.test(module)) {
      problems.push({
        message: `the SQLite Candor runs on has no ${module} module, so this migration fails`,
        help: `write \`USING fts5(...)\`: same columns, and \`MATCH\` queries the same way`,
      });
    }
  }
  return problems;
}

/** The schema the DDL statements make, in order. `ddl`: each `sql.exec` text and where it is. */
export function readSchema(ddl: { text: string; where: string }[]): Schema {
  const schema: Schema = new Map();
  for (const { text, where } of ddl) {
    for (const s of statements(tokenize(text))) {
      const w = s.map(upper);
      if (w[0] === 'CREATE' && (w[1] === 'TABLE' || (w[2] === 'TABLE' && (w[1] === 'TEMP' || w[1] === 'TEMPORARY')))) {
        let i = w.indexOf('TABLE') + 1;
        if (w[i] === 'IF' && w[i + 1] === 'NOT' && w[i + 2] === 'EXISTS') i += 3;
        const q = tableName(s, i);
        if (!q) continue;
        const name = q.name;
        const body = group(s, q.next);
        if (!body) continue;
        const columns: SqlColumn[] = [];
        const keys: string[] = [];
        for (const def of commaSplit(body.inner)) {
          const first = upper(def[0]);
          if (first === 'PRIMARY') {
            // `PRIMARY KEY (a, b)`: those columns are never NULL.
            const cols = group(def, 2);
            if (cols) keys.push(...commaSplit(cols.inner).map((c) => c[0]?.v.toLowerCase() ?? ''));
            continue;
          }
          if (['CONSTRAINT', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(first)) continue;
          const col = columnDef(def);
          if (col) columns.push(col);
        }
        for (const c of columns) if (keys.includes(c.name.toLowerCase())) c.nullable = false;
        if (!w.slice(body.next).includes('WITHOUT')) withRowid(columns);
        if (!(w[w.indexOf('TABLE') + 1] === 'IF' && schema.has(name.toLowerCase()))) schema.set(name.toLowerCase(), { name, columns, where });
      } else if (w[0] === 'CREATE' && w[1] === 'VIRTUAL' && w[2] === 'TABLE') {
        const i = w[3] === 'IF' && w[4] === 'NOT' && w[5] === 'EXISTS' ? 6 : 3;
        const q = tableName(s, i);
        if (!q || w[q.next] !== 'USING' || !isName(s[q.next + 1])) continue;
        const table = virtualTable(q.name, s[q.next + 1].v, group(s, q.next + 2)?.inner ?? [], where);
        if (!(w[3] === 'IF' && schema.has(q.name.toLowerCase()))) schema.set(q.name.toLowerCase(), table);
      } else if (w[0] === 'ALTER' && w[1] === 'TABLE' && tableName(s, 2)) {
        const q = tableName(s, 2)!;
        const n = q.next;
        const table = schema.get(q.name.toLowerCase());
        if (!table) continue;
        if (w[n] === 'ADD') {
          const col = columnDef(s.slice(w[n + 1] === 'COLUMN' ? n + 2 : n + 1));
          if (col) table.columns.push(col);
        } else if (w[n] === 'RENAME' && w[n + 1] === 'TO' && isName(s[n + 2])) {
          // The new name is bare: the table stays in its database.
          schema.delete(table.name.toLowerCase());
          table.name = table.name.slice(0, table.name.length - bare(table.name).length) + s[n + 2].v;
          schema.set(table.name.toLowerCase(), table);
        } else if (w[n] === 'RENAME') {
          const at = w[n + 1] === 'COLUMN' ? n + 2 : n + 1;
          const col = table.columns.find((c) => c.name.toLowerCase() === s[at]?.v.toLowerCase());
          if (col && w[at + 1] === 'TO' && isName(s[at + 2])) col.name = s[at + 2].v;
        } else if (w[n] === 'DROP') {
          const at = w[n + 1] === 'COLUMN' ? n + 2 : n + 1;
          table.columns = table.columns.filter((c) => c.name.toLowerCase() !== s[at]?.v.toLowerCase());
        }
      } else if (w[0] === 'DROP' && w[1] === 'TABLE') {
        const q = tableName(s, w[2] === 'IF' ? 4 : 2);
        if (q) schema.delete(q.name.toLowerCase());
      }
    }
  }
  return schema;
}

/** Whether `text` changes the schema rather than reading or writing rows. */
export function isDdl(text: string): boolean {
  const first = upper(tokenize(text)[0]);
  return first === 'CREATE' || first === 'ALTER' || first === 'DROP';
}

// Words in a WHERE, SET or ORDER BY that aren't columns.
const sqlWords = new Set([
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'ESCAPE', 'ASC', 'DESC', 'COLLATE', 'NOCASE',
  'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'DISTINCT', 'NULLS', 'FIRST', 'LAST',
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'RTRIM', 'BINARY', 'CAST', 'AS', 'INTEGER', 'TEXT',
  'WHERE', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'RETURNING', 'ON', 'CONFLICT', 'DO', 'NOTHING',
  'ISNULL', 'NOTNULL', 'REGEXP', 'MATCH', 'FROM',
]);
// Card 142: words of a window's spec.
const windowWords = new Set(['PARTITION', 'ROWS', 'RANGE', 'GROUPS', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'EXCLUDE', 'NO', 'OTHERS', 'TIES']);
const comparisons = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=']);
// Words that end a table in FROM, or start a join.
const joinWords = new Set(['JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER', 'NATURAL', 'ON', 'USING']);
const afterFrom = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW']);
// Over no GROUP BY these make one row of the whole table; `min(a, b)` and `max(a, b)` are scalar.
const aggregateFns = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL', 'GROUP_CONCAT']);

const isP = (t: Tok | undefined, v: string) => t?.k === 'punct' && t.v === v;

/** Card 137: each `(SELECT ...)` becomes one `sub` token holding its own tokens, so the query around it sees one value there. */
function lift(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const g = isP(toks[i], '(') && ['SELECT', 'WITH'].includes(upper(toks[i + 1])) ? group(toks, i) : null;
    if (g) {
      out.push({ k: 'sub', v: '(SELECT ...)', at: toks[i].at, end: toks[g.next - 1].end, inner: lift(g.inner) });
      i = g.next - 1;
    } else {
      out.push(toks[i]);
    }
  }
  return out;
}

/** A query a WITH names: `name [(cols)] AS (SELECT ...)`. */
interface Cte {
  name: string;
  cols: string[] | null;
  body: Tok;
}

/** Card 139: the queries of the WITH at `i`, and the index of the statement after them; or why it isn't read. */
function withClause(s: Tok[], i: number): { ctes: Cte[]; next: number } | { why: string } {
  i++;
  if (upper(s[i]) === 'RECURSIVE') return { why: 'it has a recursive WITH' };
  const ctes: Cte[] = [];
  for (;;) {
    if (!isName(s[i])) return { why: "the check doesn't read its WITH clause" };
    const name = s[i++].v;
    let cols: string[] | null = null;
    const named = group(s, i);
    if (named) {
      cols = commaSplit(named.inner).map((c) => c[0]?.v ?? '');
      i = named.next;
    }
    if (upper(s[i]) !== 'AS') return { why: "the check doesn't read its WITH clause" };
    i++;
    if (upper(s[i]) === 'NOT') i++;
    if (upper(s[i]) === 'MATERIALIZED') i++;
    const body = s[i];
    if (body?.k !== 'sub') return { why: upper(s[i + 1]) === 'VALUES' ? 'a query of its WITH is VALUES' : "the check doesn't read its WITH clause" };
    ctes.push({ name, cols, body });
    if (!isP(s[++i], ',')) return { ctes, next: i };
    i++;
  }
}

/** Why one SELECT is beyond what is checked, or null. */
function unsupported(w: string[], toks: Tok[]): string | null {
  if (w.includes('NATURAL')) return 'it has a NATURAL join';
  if (toks.some((t, i) => t.k === 'word' && isP(toks[i + 1], '(') && upper(toks[i - 1]) === 'FROM')) return 'it reads a table-valued function';
  return null;
}

/** Whether a SELECT item calls an aggregate: `count(*)`, `max(x)`, not `max(a, b)`, nor one over a window. */
function aggregates(expr: Tok[]): boolean {
  return expr.some((t, j) => {
    if (t.k !== 'word' || !aggregateFns.has(upper(t))) return false;
    const g = group(expr, j + 1);
    return g !== null && ((upper(t) !== 'MIN' && upper(t) !== 'MAX') || commaSplit(g.inner).length === 1) && windowAt(expr, g.next) === null;
  });
}

/** Card 142: `[FILTER (WHERE ...)] OVER w | OVER (...)` after a call, at `i`: the index after it, or null if there is no OVER. */
function windowAt(toks: Tok[], i: number): number | null {
  if (upper(toks[i]) === 'FILTER') i = group(toks, i + 1)?.next ?? i + 1;
  if (upper(toks[i]) !== 'OVER') return null;
  return isP(toks[i + 1], '(') ? (group(toks, i + 1)?.next ?? toks.length) : i + 2;
}

/**
 * A table a query reads, by the name it goes by there. `outer`: an outer join can give NULL for
 * its whole row. `level`: 0 is the query's own; 1 and up an enclosing query's, which a
 * subquery may name (card 137).
 */
interface Source {
  alias: string;
  table: SqlTable;
  outer: boolean;
  level: number;
}

/** What an expression gives. `null`: the NULL literal. `aggregate`: NULL when no rows match (`sum`, `max`, ...). */
interface Typed {
  type: SqlType | 'null';
  nullable: boolean;
  aggregate?: boolean;
}

/** A column a SELECT gives. `column`: it is a table's column, bare; `label` is `table.col` then, or the expression. */
interface Out {
  name: string;
  label: string;
  type: SqlType;
  nullable: boolean;
  because: 'column' | 'outer' | 'aggregate' | 'expr';
  column?: string;
  where?: string;
  /** Its type is known; an expression the check can't type is false. */
  known: boolean;
}

/**
 * What a SELECT gives: its columns, the tables it reads, whether it checked clean (every column
 * named, no errors), and whether it always gives one row (an aggregate with no GROUP BY).
 */
interface Shape {
  outs: Out[];
  scope: Source[];
  ok: boolean;
  oneRow: boolean;
}

interface Env {
  params: SqlParam[];
  /** A column by `qual.name` or `name`, quietly: null when there is no such column, or more than one. */
  column: (qual: string | null, name: string) => Typed | null;
  /** The SELECT has a GROUP BY, so every group has a row. */
  grouped: boolean;
  /** What a subquery gives, checked once. */
  sub: (t: Tok) => Shape | null;
  /** #b29bfb64: the functions the program registers with `sql.function`. */
  fns: SqlFns;
}

/** #b29bfb64: a function registered with `sql.function`: its parameters and what it gives. */
export interface SqlFn {
  name: string;
  /** The Candor function, `module.fn`, for messages. */
  fn: string;
  params: { name: string; type: SqlType; optional: boolean }[];
  ret: { type: SqlType; optional: boolean };
}

/** Registered functions by uppercase name. */
export type SqlFns = Map<string, SqlFn>;

/** SQLite's own scalar, aggregate and window functions, which `sql.function` can't take. */
const sqliteFunctions = new Set(
  (
    'ABS CHANGES CHAR COALESCE CONCAT CONCAT_WS FORMAT GLOB HEX IFNULL IIF INSTR LAST_INSERT_ROWID LENGTH LIKE LIKELIHOOD LIKELY LOAD_EXTENSION ' +
    'LOWER LTRIM MAX MIN NULLIF OCTET_LENGTH PRINTF QUOTE RANDOM RANDOMBLOB REPLACE ROUND RTRIM SIGN SOUNDEX SQLITE_COMPILEOPTION_GET ' +
    'SQLITE_COMPILEOPTION_USED SQLITE_OFFSET SQLITE_SOURCE_ID SQLITE_VERSION SUBSTR SUBSTRING TOTAL_CHANGES TRIM TYPEOF UNHEX UNICODE ' +
    'UNLIKELY UPPER ZEROBLOB AVG COUNT GROUP_CONCAT STRING_AGG SUM TOTAL DATE TIME DATETIME JULIANDAY UNIXEPOCH STRFTIME TIMEDIFF ' +
    'ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE ' +
    'ACOS ACOSH ASIN ASINH ATAN ATAN2 ATANH CEIL CEILING COS COSH DEGREES EXP FLOOR LN LOG LOG10 LOG2 MOD PI POW POWER RADIANS SIN SINH SQRT TAN TANH TRUNC ' +
    'JSON JSONB JSON_ARRAY JSON_ARRAY_LENGTH JSON_EXTRACT JSON_INSERT JSON_OBJECT JSON_PATCH JSON_REMOVE JSON_REPLACE JSON_SET JSON_TYPE JSON_VALID ' +
    'JSON_QUOTE JSON_GROUP_ARRAY JSON_GROUP_OBJECT JSON_EACH JSON_TREE HIGHLIGHT SNIPPET BM25 MATCH REGEXP'
  ).split(' '),
);

/** Whether SQLite has a function by this name already. */
export function sqliteHasFunction(name: string): boolean {
  return sqliteFunctions.has(name.toUpperCase());
}

/**
 * #b29bfb64: each call of a registered function in `text`, triggers and indexes too: how many
 * arguments it is given, and the type of a `${}` given as one.
 */
export function checkFunctionCalls(text: string, params: SqlParam[], fns: SqlFns): SqlProblem[] {
  if (fns.size === 0) return [];
  const problems: SqlProblem[] = [];
  const walk = (toks: Tok[]) => {
    toks.forEach((t, i) => {
      if (t.inner) walk(t.inner);
      const fn = t.k === 'word' && isP(toks[i + 1], '(') ? fns.get(t.v.toUpperCase()) : undefined;
      const g = fn ? group(toks, i + 1) : null;
      if (!fn || !g) return;
      const args = g.inner.length === 0 ? [] : commaSplit(g.inner);
      if (args.length !== fn.params.length) {
        problems.push({
          message: `\`${t.v}\` takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, and is given ${args.length}`,
          help: `it is \`${fn.fn}(${fn.params.map((p) => p.name).join(', ')})\`, registered with \`sql.function\``,
        });
        return;
      }
      args.forEach((a, j) => {
        const p = a.length === 1 && a[0].k === 'param' && a[0].param !== undefined ? params[a[0].param] : undefined;
        const want = fn.params[j];
        if (!p || p.type === 'other' || want.type === 'other') return;
        if (p.type === 'none' || p.optional) {
          if (!want.optional) problems.push({ message: `\`${t.v}\`'s parameter \`${want.name}\` isn't optional, and is given ${p.type === 'none' ? '`none`' : 'a `T?`'}`, help: `give it a value, or make \`${want.name}\` a \`${want.type}?\` in \`${fn.fn}\`` });
          if (p.type === 'none') return;
        }
        const fits = p.type === want.type || (want.type === 'float' && p.type === 'int') || (want.type === 'bool' && p.type === 'int') || (want.type === 'int' && p.type === 'bool');
        if (!fits) problems.push({ message: `\`${t.v}\`'s parameter \`${want.name}\` is ${typeName(want.type)}, and is given ${typeName(p.type)}`, help: textOrBytes(p.type, want.type) ?? `pass ${typeName(want.type)}, as \`${fn.fn}\` takes` });
      });
    });
  };
  walk(tokenize(text));
  return problems;
}

const numeric = (t: SqlType | 'null') => t === 'int' || t === 'float' || t === 'bool';
const textFns = new Set(['LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTR', 'SUBSTRING', 'REPLACE', 'HEX', 'PRINTF', 'FORMAT']);

/** One type for several values (`coalesce`, scalar `max`): the same, or int and float as float; NULLs don't count. */
function common(xs: (Typed | null)[]): SqlType | null {
  if (xs.some((x) => !x)) return null;
  const types = (xs as Typed[]).map((x) => x.type).filter((t) => t !== 'null');
  if (types.length === 0) return null;
  if (types.every((t) => t === types[0])) return types[0] as SqlType;
  if (types.every(numeric)) return types.includes('float') ? 'float' : 'int';
  return null;
}

/**
 * The type of an expression in a SELECT: columns, `${}` values, literals, arithmetic, `||`,
 * comparisons, AND/OR/NOT, CASE, CAST, subqueries and common functions. Null when the check
 * can't tell.
 */
function typeExpr(toks: Tok[], env: Env): Typed | null {
  let i = 0;
  const w = (j: number) => upper(toks[j]);
  // A comparison or a test is 0 or 1; NULL when an operand is, unless `nullable` says.
  const bool = (xs: (Typed | null)[], nullable?: boolean): Typed | null =>
    xs.every((x) => x) ? { type: 'bool', nullable: nullable ?? xs.some((x) => x!.nullable), aggregate: xs.some((x) => x!.aggregate) } : null;
  const arith = (a: Typed | null, b: Typed | null): Typed | null => {
    if (!a || !b || !numeric(a.type) || !numeric(b.type)) return null;
    return { type: a.type === 'float' || b.type === 'float' ? 'float' : 'int', nullable: a.nullable || b.nullable, aggregate: a.aggregate || b.aggregate };
  };
  /** A subquery's one column; `scalar`: as a value, NULL when it finds no row. */
  const column1 = (t: Tok, scalar: boolean): Typed | null => {
    const shape = env.sub(t);
    const o = shape?.outs.length === 1 ? shape.outs[0] : null;
    if (!o || !o.known || o.type === 'other') return null;
    return { type: o.type, nullable: o.nullable || (scalar && !shape!.oneRow) };
  };
  const or = (): Typed | null => {
    let left = and();
    while (w(i) === 'OR') {
      i++;
      left = bool([left, and()]);
    }
    return left;
  };
  const and = (): Typed | null => {
    let left = not();
    while (w(i) === 'AND') {
      i++;
      left = bool([left, not()]);
    }
    return left;
  };
  const not = (): Typed | null => {
    if (w(i) !== 'NOT') return compare();
    i++;
    return bool([not()]);
  };
  const compare = (): Typed | null => {
    let left = sum();
    for (;;) {
      const t = toks[i];
      if (t?.k === 'punct' && comparisons.has(t.v)) {
        i++;
        left = bool([left, sum()]);
        continue;
      }
      if (w(i) === 'IS') {
        i++;
        if (w(i) === 'NOT') i++;
        if (w(i) === 'DISTINCT' && w(i + 1) === 'FROM') i += 2;
        left = bool([left, sum()], false);
        continue;
      }
      if (w(i) === 'ISNULL' || w(i) === 'NOTNULL' || (w(i) === 'NOT' && w(i + 1) === 'NULL')) {
        i += w(i) === 'NOT' ? 2 : 1;
        left = bool([left], false);
        continue;
      }
      const neg = w(i) === 'NOT' ? 1 : 0;
      const op = w(i + neg);
      if (op === 'IN') {
        i += neg + 1;
        const list = toks[i];
        if (list?.k === 'sub') {
          i++;
          left = bool([left, column1(list, false)]);
          continue;
        }
        const g = group(toks, i);
        if (!g) return null;
        i = g.next;
        left = bool([left, ...(g.inner.length === 0 ? [] : commaSplit(g.inner).map((x) => typeExpr(x, env)))]);
        continue;
      }
      if (op === 'LIKE' || op === 'GLOB' || op === 'REGEXP' || op === 'MATCH') {
        i += neg + 1;
        const pattern = sum();
        let escape: Typed | null = { type: 'string', nullable: false };
        if (w(i) === 'ESCAPE') {
          i++;
          escape = sum();
        }
        left = bool([left, pattern, escape]);
        continue;
      }
      if (op === 'BETWEEN') {
        i += neg + 1;
        const low = sum();
        if (w(i) !== 'AND') return null;
        i++;
        left = bool([left, low, sum()]);
        continue;
      }
      return left;
    }
  };
  const sum = (): Typed | null => {
    let left = product();
    while (isP(toks[i], '+') || isP(toks[i], '-')) {
      i++;
      left = arith(left, product());
    }
    return left;
  };
  const product = (): Typed | null => {
    let left = concat();
    while (isP(toks[i], '*') || isP(toks[i], '/') || isP(toks[i], '%')) {
      i++;
      left = arith(left, concat());
    }
    return left;
  };
  const concat = (): Typed | null => {
    let left = unary();
    while (isP(toks[i], '||')) {
      i++;
      const right = unary();
      left = left && right ? { type: 'string', nullable: left.nullable || right.nullable, aggregate: left.aggregate || right.aggregate } : null;
    }
    return left;
  };
  const unary = (): Typed | null => {
    if (isP(toks[i], '-') || isP(toks[i], '+')) {
      i++;
      const x = unary();
      return x && numeric(x.type) ? x : null;
    }
    return primary();
  };
  /** `CASE [x] WHEN ... THEN r ... [ELSE e] END`: what its results share; NULL with no ELSE. */
  const caseOf = (): Typed | null => {
    let depth = 0;
    let end = -1;
    for (let j = i; j < toks.length && end < 0; j++) {
      if (w(j) === 'CASE') depth++;
      if (w(j) === 'END' && --depth === 0) end = j;
    }
    if (end < 0) return null;
    const parts: { word: string; toks: Tok[] }[] = [{ word: 'CASE', toks: [] }];
    depth = 0;
    for (let j = i + 1; j < end; j++) {
      if (w(j) === 'CASE') depth++;
      if (w(j) === 'END') depth--;
      if (depth === 0 && ['WHEN', 'THEN', 'ELSE'].includes(w(j))) parts.push({ word: w(j), toks: [] });
      else parts[parts.length - 1].toks.push(toks[j]);
    }
    i = end + 1;
    const results = parts.filter((p) => p.word === 'THEN' || p.word === 'ELSE').map((p) => typeExpr(p.toks, env));
    const type = common(results);
    if (!type) return null;
    return { type, nullable: !parts.some((p) => p.word === 'ELSE') || results.some((x) => x!.nullable), aggregate: results.some((x) => x!.aggregate) };
  };
  const primary = (): Typed | null => {
    const t = toks[i];
    if (!t) return null;
    if (t.k === 'sub') {
      i++;
      return column1(t, true);
    }
    if (isP(t, '(')) {
      const g = group(toks, i);
      if (!g) return null;
      i = g.next;
      return typeExpr(g.inner, env);
    }
    if (t.k === 'param') {
      i++;
      const p = t.param === undefined ? undefined : env.params[t.param];
      if (!p || p.type === 'other') return null;
      return p.type === 'none' ? { type: 'null', nullable: true } : { type: p.type, nullable: p.optional };
    }
    if (t.k === 'num') {
      i++;
      return { type: /[.eE]/.test(t.v) ? 'float' : 'int', nullable: false };
    }
    if (t.k === 'str') {
      i++;
      return { type: 'string', nullable: false };
    }
    const u = upper(t);
    if (u === 'NULL') {
      i++;
      return { type: 'null', nullable: true };
    }
    if (u === 'TRUE' || u === 'FALSE') {
      i++;
      return { type: 'bool', nullable: false };
    }
    if (u === 'EXISTS' && toks[i + 1]?.k === 'sub') {
      env.sub(toks[i + 1]);
      i += 2;
      return { type: 'bool', nullable: false };
    }
    if (u === 'CASE') return caseOf();
    if (t.k === 'word' && isP(toks[i + 1], '(')) {
      const g = group(toks, i + 1);
      if (!g) return null;
      i = g.next;
      if (u === 'CAST') return cast(g.inner, env);
      // Card 142: over a window, an aggregate gives a value for each row, not one for them all.
      const over = windowAt(toks, i);
      if (over === null) return call(u, g.inner, env);
      i = over;
      const x = windowCall(u, g.inner, env) ?? call(u, g.inner, { ...env, grouped: true });
      return x && { ...x, aggregate: false };
    }
    if (!isName(t) || (t.k === 'word' && sqlWords.has(u))) return null;
    if (isP(toks[i + 1], '.') && isName(toks[i + 2])) {
      i += 3;
      return env.column(t.v, toks[i - 1].v);
    }
    i++;
    return env.column(null, t.v);
  };
  const whole = or();
  return i === toks.length ? whole : null;
}

/** `CAST(x AS INTEGER)`: the type it names, NULL if `x` is. An `x` the check can't type is taken as not NULL: the CAST is how a query names a type. */
function cast(inner: Tok[], env: Env): Typed | null {
  let as = -1;
  let depth = 0;
  inner.forEach((t, j) => {
    if (isP(t, '(')) depth++;
    if (isP(t, ')')) depth--;
    if (depth === 0 && upper(t) === 'AS') as = j;
  });
  if (as < 0) return null;
  const type = affinity(inner.slice(as + 1).map((t) => t.v).join(' '));
  if (type === 'other') return null;
  const x = typeExpr(inner.slice(0, as), env);
  return { type, nullable: x?.nullable ?? false, aggregate: x?.aggregate };
}

/** Card 142: a window function's type: `row_number()`, `rank()`, `lag(x)`, ...; null for others. */
function windowCall(name: string, inner: Tok[], env: Env): Typed | null {
  switch (name) {
    case 'ROW_NUMBER':
    case 'RANK':
    case 'DENSE_RANK':
    case 'NTILE':
      return { type: 'int', nullable: false };
    case 'PERCENT_RANK':
    case 'CUME_DIST':
      return { type: 'float', nullable: false };
    case 'LAG':
    case 'LEAD':
    case 'FIRST_VALUE':
    case 'LAST_VALUE':
    case 'NTH_VALUE': {
      const args = inner.length === 0 ? [] : commaSplit(inner).map((a) => typeExpr(a, env));
      const x = args[0];
      if (!x || x.type === 'null') return null;
      // `lag(x)` is NULL before the first row, unless a default is given; `nth_value` past the frame.
      const past = name === 'NTH_VALUE' || ((name === 'LAG' || name === 'LEAD') && (args.length < 3 || args[2] === null || args[2].nullable));
      return { type: x.type, nullable: x.nullable || past };
    }
  }
  return null;
}

/** A function call's type, for the functions the check knows. */
function call(name: string, inner: Tok[], env: Env): Typed | null {
  const args = inner.length === 0 ? [] : commaSplit(inner);
  const own = env.fns.get(name);
  if (own) return own.ret.type === 'other' ? null : { type: own.ret.type, nullable: own.ret.optional };
  const each = () => args.map((a) => typeExpr(upper(a[0]) === 'DISTINCT' ? a.slice(1) : a, env));
  switch (name) {
    case 'COUNT':
      return { type: 'int', nullable: false };
    case 'TOTAL':
      return { type: 'float', nullable: false };
    case 'SUM':
    case 'AVG':
    case 'MIN':
    case 'MAX': {
      if (args.length === 1) {
        const [x] = each();
        if (!x || x.type === 'null' || ((name === 'SUM' || name === 'AVG') && !numeric(x.type))) return null;
        // Over no rows these are NULL; a group has a row, so there only a NULL column makes one.
        return { type: name === 'AVG' ? 'float' : x.type, nullable: x.nullable || !env.grouped, aggregate: !env.grouped };
      }
      if (name === 'SUM' || name === 'AVG') return null;
      const xs = each();
      const type = common(xs);
      return type ? { type, nullable: xs.some((x) => x!.nullable) } : null;
    }
    case 'COALESCE':
    case 'IFNULL': {
      const xs = each();
      const type = common(xs);
      return type ? { type, nullable: xs.every((x) => x!.nullable), aggregate: xs.every((x) => x!.aggregate) } : null;
    }
    case 'IIF': {
      const xs = each().slice(1);
      const type = args.length === 3 ? common(xs) : null;
      return type ? { type, nullable: xs.some((x) => x!.nullable), aggregate: xs.some((x) => x!.aggregate) } : null;
    }
    case 'NULLIF': {
      const [x] = each();
      return x && x.type !== 'null' ? { type: x.type, nullable: true } : null;
    }
    case 'LENGTH':
    case 'INSTR': {
      const xs = each();
      return xs.every((x) => x) ? { type: 'int', nullable: xs.some((x) => x!.nullable) } : null;
    }
    case 'ABS': {
      const [x] = each();
      return x && numeric(x.type) ? { ...x, type: x.type === 'float' ? 'float' : 'int' } : null;
    }
    case 'ROUND': {
      const [x] = each();
      return x && numeric(x.type) ? { type: 'float', nullable: x.nullable } : null;
    }
    case 'TYPEOF':
      return { type: 'string', nullable: false };
    case 'GROUP_CONCAT':
      return { type: 'string', nullable: true, aggregate: !env.grouped };
    case 'LAST_INSERT_ROWID':
    case 'CHANGES':
    case 'TOTAL_CHANGES':
    case 'RANDOM':
      return { type: 'int', nullable: false };
  }
  if (!textFns.has(name)) return null;
  const xs = each();
  return xs.every((x) => x) ? { type: 'string', nullable: xs.some((x) => x!.nullable) } : null;
}

/**
 * Problems with one query, `text` with a `?` for each `${}` (`params`, in order), on `schema`.
 * `row`: what `sql.query<T>` reads into; null for exec and insert.
 */
export function checkSql(text: string, params: SqlParam[], schema: Schema, row: RowShape | null, fns: SqlFns = new Map()): SqlProblem[] {
  const toks = tokenize(text);
  const stmts = statements(toks);
  if (stmts.length !== 1) return [];
  // `vault.secrets.col` is `secrets.col`: the column of the table by the name it goes by.
  const flat: Tok[] = [];
  for (let i = 0; i < stmts[0].length; i++) {
    const t = stmts[0];
    if (isName(t[i]) && isP(t[i + 1], '.') && isName(t[i + 2]) && isP(t[i + 3], '.') && isName(t[i + 4])) i++;
    else flat.push(t[i]);
  }
  const lead = lift(flat);
  // Card 139: `WITH a AS (...), ...` before the statement; its queries are tables in it.
  const top = upper(lead[0]) === 'WITH' ? withClause(lead, 0) : null;
  const topCtes = top && 'ctes' in top ? top.ctes : [];
  const s = top && 'ctes' in top ? lead.slice(top.next) : lead;
  const w = s.map(upper);
  const kind = w[0];
  const problems: SqlProblem[] = [];
  const note = (why: string) => problems.push({ note: true, message: `this query is not checked against the schema: ${why}`, help: 'the database checks it when it runs' });
  const errors = () => problems.filter((p) => !p.note).length;
  if (top && 'why' in top) {
    note(top.why);
    return problems;
  }
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(kind)) return [];
  // Subqueries by their token, so the clause that names one and the type of a column check it once.
  const shapes = new Map<Tok, Shape | null>();
  const shapeOf = (t: Tok, scope: Source[]): Shape | null => {
    if (!shapes.has(t)) {
      shapes.set(t, null);
      shapes.set(t, select(t.inner ?? [], scope));
    }
    return shapes.get(t)!;
  };
  // Card 139: the queries a WITH names, as tables, by lowercase name; null for one with a mistake
  // (already reported) or that reads itself. `building`: the ones whose own query is being read.
  const named = new Map<string, SqlTable | null>();
  const building = new Set<string>();
  let recursed = false;

  /** The table named at `i` in `s`, or a subquery read as one, and the index after it. */
  const tableAt = (s: Tok[], i: number): { table: SqlTable; next: number } | null => {
    if (s[i]?.k === 'sub') {
      const shape = shapeOf(s[i], []);
      if (!shape?.ok) return null;
      const columns = shape.outs.map((o) => ({ name: o.name, type: o.known ? o.type : ('other' as SqlType), nullable: o.nullable, required: false }));
      return { table: { name: '(subquery)', columns, where: '' }, next: i + 1 };
    }
    const q = tableName(s, i);
    if (!q) return null;
    const key = q.name.toLowerCase();
    if (building.has(key)) {
      recursed = true;
      return null;
    }
    if (named.has(key)) {
      const t = named.get(key);
      // A copy: the FROM names it by its alias.
      return t ? { table: { ...t }, next: q.next } : null;
    }
    const table = findTable(schema, q.name) ?? builtinTable(q.name);
    if (table?.opaque) {
      note(table.opaque);
      return null;
    }
    if (!table) {
      const names = [...schema.values()].map((x) => `\`${x.name}\``);
      problems.push({
        message: `there is no table \`${q.name}\` in the schema the migrations make`,
        help: names.length > 0 ? `the tables are ${names.join(', ')}` : 'no CREATE TABLE was found in a `sql.exec`',
      });
      return null;
    }
    return { table, next: q.next };
  };
  const columnOf = (table: SqlTable, name: string): SqlColumn | null => {
    const col = table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!col) {
      const cols = shown(table).map((c) => c.name).join(', ');
      problems.push({
        message: `\`${table.name}\` has no column \`${name}\``,
        help: table.where ? `its columns are ${cols}, as the migration at ${table.where} makes them` : table.builtin ? `its columns are ${cols}` : `it selects ${cols}`,
      });
    }
    return col ?? null;
  };
  const has = (table: SqlTable, name: string) => table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const sourceOf = (scope: Source[], qual: string, report: boolean): Source | null => {
    const src = scope.find((x) => x.alias.toLowerCase() === qual.toLowerCase());
    if (!src && report) {
      problems.push({ message: `there is no table \`${qual}\` in this query`, help: `it reads ${scope.map((x) => (x.alias === x.table.name ? `\`${x.alias}\`` : `\`${x.table.name}\` as \`${x.alias}\``)).join(', ')}` });
    }
    return src ?? null;
  };
  /** The column `qual.name`, or `name` in whichever table has it, the nearest query's first; errors when `report`. */
  const resolve = (scope: Source[], qual: string | null, name: string, report: boolean): { col: SqlColumn; src: Source } | null => {
    if (qual !== null) {
      const src = sourceOf(scope, qual, report);
      if (!src) return null;
      const col = report ? columnOf(src.table, name) : has(src.table, name);
      return col ? { col, src } : null;
    }
    const all = scope.filter((x) => has(x.table, name));
    const found = all.filter((x) => x.level === Math.min(...all.map((y) => y.level)));
    if (found.length === 1) return { col: has(found[0].table, name)!, src: found[0] };
    if (!report) return null;
    const own = scope.filter((x) => x.level === 0);
    if (found.length > 1) {
      problems.push({
        message: `\`${name}\` is a column of ${found.map((x) => `\`${x.table.name}\``).join(' and ')}, so the database can't tell which`,
        help: `name its table: \`${found[0].alias}.${name}\``,
      });
    } else if (own.length === 1) {
      columnOf(own[0].table, name);
    } else {
      problems.push({
        message: `no table in this query has a column \`${name}\``,
        help: scope.map((x) => `\`${x.table.name}\` has ${shown(x.table).map((c) => c.name).join(', ')}`).join('; '),
      });
    }
    return null;
  };
  const fits = (value: SqlType | 'none', col: SqlType) =>
    value === 'none' || value === 'other' || col === 'other' || value === col || (col === 'int' && value === 'bool') || (col === 'bool' && value === 'int') || (col === 'float' && value === 'int');
  const paramInto = (p: Tok | undefined, table: SqlTable, col: SqlColumn, storing: boolean) => {
    if (p?.k !== 'param' || p.param === undefined) return;
    const v = params[p.param];
    if (!v) return;
    if (!fits(v.type, col.type)) {
      problems.push({
        message: `${typeName(v.type)} goes into \`${table.name}.${col.name}\`, which holds ${typeName(col.type)} (${table.where})`,
        help: textOrBytes(v.type, col.type) ?? (col.type === 'string' ? 'pass it as text: `${x.toString()}`' : 'pass a value of the column\'s type, or change the column in a migration'),
      });
    } else if (storing && !col.nullable && (v.type === 'none' || v.optional)) {
      problems.push({
        message: `\`${table.name}.${col.name}\` is NOT NULL, and this value can be none (${table.where})`,
        help: 'give a value with `??`, or make the column nullable in a migration',
      });
    }
  };
  // Every bare word in a clause is a column, but words of SQL, function names (`lower(`) and
  // the SELECT's own names; `t.col` is a column of the table `t` names. A subquery is checked
  // with the tables around it in reach.
  const clause = (s: Tok[], from: number, to: number, scope: Source[], outNames: Set<string>, skip: Set<string> = sqlWords) => {
    for (let i = from; i < to; i++) {
      const t = s[i];
      // `count(*) AS n`, `CAST(x AS REAL)`: a new name, or a type.
      if (upper(s[i - 1]) === 'AS') continue;
      if (t.k === 'sub') {
        const shape = shapeOf(t, scope);
        const width = rowWidth(s, i);
        if (shape?.ok && upper(s[i - 1]) !== 'EXISTS' && shape.outs.length !== width) {
          problems.push(
            width === 1
              ? { message: `this subquery is used as a value, and selects ${shape.outs.length} columns`, help: 'select one column; `EXISTS (SELECT ...)` asks whether there are rows' }
              : { message: `this subquery is compared with a row of ${width} values, and selects ${shape.outs.length} column${shape.outs.length === 1 ? '' : 's'}`, help: `select ${width} columns, one for each value in the row` },
          );
        }
        continue;
      }
      // Card 142: `OVER (PARTITION BY a ORDER BY b ROWS ...)`, `OVER w`, `WINDOW w AS (...), ...`.
      if (upper(t) === 'OVER' || upper(t) === 'WINDOW') {
        i = windows(s, i, scope, outNames) - 1;
        continue;
      }
      let found: { col: SqlColumn; src: Source } | null = null;
      let last = i;
      if (isName(t) && isP(s[i + 1], '.') && (isName(s[i + 2]) || isP(s[i + 2], '*'))) {
        last = i + 2;
        if (isP(s[i + 2], '*')) sourceOf(scope, t.v, true);
        else found = resolve(scope, t.v, s[i + 2].v, true);
      } else if (t.k === 'quoted' || (t.k === 'word' && !skip.has(upper(t)) && !isP(s[i + 1], '('))) {
        if (outNames.has(t.v.toLowerCase()) && !scope.some((x) => has(x.table, t.v))) continue;
        found = resolve(scope, null, t.v, true);
      }
      if (found) {
        // `col = ?` and `? = col`: the value is compared with the column.
        const { col, src } = found;
        const next = s[last + 1];
        if (next?.k === 'punct' && comparisons.has(next.v)) paramInto(s[last + 2], src.table, col, false);
        const before = s[i - 1];
        if (before?.k === 'punct' && comparisons.has(before.v)) paramInto(s[i - 2], src.table, col, false);
        if (upper(next) === 'IN') {
          const list = group(s, last + 2);
          for (const item of list ? commaSplit(list.inner) : []) if (item.length === 1) paramInto(item[0], src.table, col, false);
        }
      }
      i = last;
    }
  };
  /**
   * Card 142: the window at `i`, `OVER w` or `OVER (spec)`, or a `WINDOW w AS (spec), ...` clause;
   * gives the index after it. A spec's own words aren't columns; what it partitions and orders by are.
   */
  const windows = (s: Tok[], i: number, scope: Source[], outNames: Set<string>): number => {
    const spec = (at: number): number => {
      const g = group(s, at);
      if (!g) return at;
      let from = at + 1;
      // `OVER (w ORDER BY x)`: a window named first.
      if (isName(s[from]) && !windowWords.has(upper(s[from]))) from++;
      clause(s, from, g.next - 1, scope, outNames, new Set([...sqlWords, ...windowWords]));
      return g.next;
    };
    if (upper(s[i]) === 'OVER') return isP(s[i + 1], '(') ? spec(i + 1) : i + 2;
    // WINDOW a AS (...), b AS (...)
    let j = i + 1;
    while (isName(s[j]) && upper(s[j + 1]) === 'AS') {
      j = spec(j + 2);
      if (!isP(s[j], ',')) break;
      j++;
    }
    return j;
  };
  /** Card 142: how many values the row a subquery at `i` is compared with has: `(a, b) < (SELECT ...)`, `(a, b) IN (SELECT ...)`; else 1. */
  const rowWidth = (s: Tok[], i: number): number => {
    const width = (open: number) => {
      const g = group(s, open);
      return g ? commaSplit(g.inner).length : 1;
    };
    const before = s[i - 1];
    if ((before?.k === 'punct' && comparisons.has(before.v)) || upper(before) === 'IN') {
      if (!isP(s[i - 2], ')')) return 1;
      let depth = 0;
      for (let j = i - 2; j >= 0; j--) {
        if (isP(s[j], ')')) depth++;
        if (isP(s[j], '(') && --depth === 0) return isName(s[j - 1]) && s[j - 1].k === 'word' && !sqlWords.has(upper(s[j - 1])) ? 1 : width(j);
      }
      return 1;
    }
    const after = s[i + 1];
    if (after?.k === 'punct' && comparisons.has(after.v) && isP(s[i + 2], '(')) return width(i + 2);
    return 1;
  };
  /** `col = value, ...` of an UPDATE or an upsert's DO UPDATE. */
  const assignments = (s: Tok[], from: number, to: number, table: SqlTable, scope: Source[]) => {
    for (const a of commaSplit(s.slice(from, to))) {
      if (!isName(a[0]) || a[1]?.v !== '=') continue;
      const col = columnOf(table, a[0].v);
      if (!col) continue;
      const value = a.slice(2);
      if (value.length === 1 && value[0].k !== 'sub') {
        paramInto(value[0], table, col, true);
        continue;
      }
      // `coalesce(${x}, col)`, `excluded.col`, `other.col`: its columns must exist.
      const offset = s.indexOf(value[0]);
      clause(s, offset, offset + value.length, scope, new Set());
      if (value.length === 3 && isP(value[1], '.') && isName(value[0]) && isName(value[2])) {
        const other = resolve(scope, value[0].v, value[2].v, false);
        if (other && !fits(other.col.type, col.type)) {
          problems.push({
            message: `\`${other.src.alias}.${other.col.name}\` is ${typeName(other.col.type)}, and \`${table.name}.${col.name}\` holds ${typeName(col.type)} (${table.where})`,
            help: textOrBytes(other.col.type, col.type) ?? 'set it from a column of its own type',
          });
        }
      }
    }
  };
  /** Where a clause of `s` starting at `from` ends: the first of `words` outside parentheses, or the end. */
  const until = (s: Tok[], from: number, words: Set<string>) => {
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      if (isP(s[i], '(')) depth++;
      if (isP(s[i], ')')) depth--;
      if (depth === 0 && words.has(upper(s[i]))) return i;
    }
    return s.length;
  };
  /** The env a SELECT list's expressions are typed in. */
  const envOf = (scope: Source[], grouped: boolean, notNull: Set<string>): Env => ({
    params,
    grouped,
    column: (qual, name) => {
      const r = resolve(scope, qual, name, false);
      if (!r || r.col.type === 'other') return null;
      return { type: r.col.type, nullable: (r.col.nullable && !notNull.has(`${r.src.alias}.${r.col.name}`.toLowerCase())) || r.src.outer };
    },
    sub: (t) => shapeOf(t, scope),
    fns,
  });
  /** The columns a SELECT list (or a RETURNING) gives; `unknown`: one names something that isn't there. */
  const selectList = (s: Tok[], from: number, to: number, scope: Source[], env: Env, notNull: Set<string>, outNames: Set<string>) => {
    const columnOut = (col: SqlColumn, src: Source): Out => {
      const nullable = col.nullable && !notNull.has(`${src.alias}.${col.name}`.toLowerCase());
      return {
        name: col.name,
        label: `${src.table.where ? src.table.name : src.alias}.${col.name}`,
        column: col.name,
        type: col.type,
        nullable: nullable || src.outer,
        because: !nullable && src.outer ? 'outer' : src.table.where ? 'column' : 'expr',
        where: src.table.where,
        known: true,
      };
    };
    const own = scope.filter((x) => x.level === 0);
    const outs: Out[] = [];
    const exprs: Tok[][] = [];
    let unknown = false;
    for (const item of commaSplit(s.slice(from, to))) {
      if (item.length === 0) continue;
      const last = item[item.length - 1];
      if (item.length === 1 && isP(item[0], '*')) {
        for (const src of own) outs.push(...shown(src.table).map((c) => columnOut(c, src)));
        continue;
      }
      if (item.length === 3 && isName(item[0]) && isP(item[1], '.') && isP(item[2], '*')) {
        const src = sourceOf(scope, item[0].v, true);
        if (src) outs.push(...shown(src.table).map((c) => columnOut(c, src)));
        else unknown = true;
        continue;
      }
      // `expr AS name`, or `expr name`.
      let expr = item;
      let alias: string | undefined;
      const before = item[item.length - 2];
      if (item.length >= 3 && upper(before) === 'AS' && isName(last)) {
        alias = last.v;
        expr = item.slice(0, -2);
      } else if (item.length >= 2 && isName(last) && (isName(before) || isP(before, ')') || before.k === 'sub') && !(last.k === 'word' && sqlWords.has(upper(last))) && !isP(before, '.') && upper(before) !== 'OVER') {
        alias = last.v;
        expr = item.slice(0, -1);
      }
      if (alias) outNames.add(alias.toLowerCase());
      exprs.push(expr);
      const errs = errors();
      const offset = s.indexOf(expr[0]);
      clause(s, offset, offset + expr.length, scope, outNames);
      if (errors() > errs) {
        unknown = true;
        continue;
      }
      const ref =
        expr.length === 1 && isName(expr[0])
          ? resolve(scope, null, expr[0].v, false)
          : expr.length === 3 && isName(expr[0]) && isP(expr[1], '.') && isName(expr[2])
            ? resolve(scope, expr[0].v, expr[2].v, false)
            : null;
      if (ref) {
        outs.push({ ...columnOut(ref.col, ref.src), name: alias ?? ref.col.name });
        continue;
      }
      const label = text.slice(expr[0].at, expr[expr.length - 1].end);
      const t = typeExpr(expr, env);
      if (!t || t.type === 'null') outs.push({ name: alias ?? label, label, type: 'other', nullable: false, because: 'expr', known: false });
      else outs.push({ name: alias ?? label, label, type: t.type, nullable: t.nullable, because: t.aggregate && t.nullable ? 'aggregate' : 'expr', known: true });
    }
    return { outs, exprs, unknown };
  };
  /** FROM a [AS] x [LEFT|INNER|CROSS|...] JOIN b [AS] y ON ... | USING (...), ...: the tables, and the ON conditions. */
  const sources = (s: Tok[], from: number, to: number): { scope: Source[]; conditions: [number, number][] } | null => {
    const w = s.map(upper);
    const scope: Source[] = [];
    const conditions: [number, number][] = [];
    for (let i = from; i < to; ) {
      const words: string[] = [];
      while (i < to && (isP(s[i], ',') || ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER', 'JOIN'].includes(w[i]))) words.push(isP(s[i], ',') ? ',' : w[i++]);
      while (isP(s[i], ',')) i++;
      if (i >= to) break;
      const found = tableAt(s, i);
      if (!found) return null;
      const { table } = found;
      i = found.next;
      let alias = bare(table.name);
      // Card 137: not past the FROM, where `rooms WHERE` once made WHERE its name.
      if (i < to && w[i] === 'AS' && isName(s[i + 1])) {
        alias = s[i + 1].v;
        i += 2;
      } else if (i < to && isName(s[i]) && !joinWords.has(w[i])) {
        alias = s[i++].v;
      }
      // A subquery read as a table goes by its alias in messages.
      if (!table.where) table.name = alias;
      if (words.includes('RIGHT') || words.includes('FULL')) for (const x of scope) x.outer = true;
      scope.push({ alias, table, outer: words.includes('LEFT') || words.includes('FULL'), level: 0 });
      if (w[i] === 'ON') {
        const end = until(s, i + 1, new Set([...joinWords].filter((x) => x !== 'ON' && x !== 'USING')));
        const stop = Math.min(end, to);
        conditions.push([i + 1, stop]);
        i = stop;
      } else if (w[i] === 'USING') {
        const cols = group(s, i + 1);
        for (const c of cols ? commaSplit(cols.inner) : []) if (c.length === 1 && isName(c[0])) for (const x of scope.slice(-2)) columnOf(x.table, c[0].v);
        i = cols ? cols.next : i + 1;
      }
      while (i < to && !isP(s[i], ',') && !['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'JOIN'].includes(w[i])) i++;
    }
    return scope.length === 0 ? null : { scope, conditions };
  };

  /** One SELECT, not a compound; `outer`: the tables of the queries around it. */
  const simpleSelect = (s: Tok[], outer: Source[]): Shape | null => {
    const w = s.map(upper);
    if (w[0] !== 'SELECT') {
      note(w[0] === 'VALUES' ? 'a part of it is VALUES' : 'it is not a SELECT');
      return null;
    }
    const why = unsupported(w, s);
    if (why) {
      note(why);
      return null;
    }
    const errs = errors();
    const from = w.indexOf('FROM');
    const listEnd = from >= 0 ? from : until(s, 1, afterFrom);
    const fromEnd = from >= 0 ? until(s, from + 1, afterFrom) : listEnd;
    const found = from >= 0 ? sources(s, from + 1, fromEnd) : { scope: [], conditions: [] };
    if (!found) return null;
    const scope = [...found.scope, ...outer.map((x) => ({ ...x, level: x.level + 1 }))];
    const grouped = w.slice(fromEnd).includes('GROUP');
    // `col IS NOT NULL` in a WHERE without OR: that column isn't NULL in what it reads.
    const whereAt = w.indexOf('WHERE', fromEnd);
    const whereEnd = whereAt < 0 ? whereAt : until(s, whereAt + 1, new Set(['GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW']));
    const notNull = new Set<string>();
    if (whereAt >= 0 && !w.slice(whereAt, whereEnd).includes('OR')) {
      for (let i = whereAt + 1; i + 2 < whereEnd; i++) {
        if (isName(s[i]) && w[i + 1] === 'IS' && w[i + 2] === 'NOT' && w[i + 3] === 'NULL') {
          const q = isP(s[i - 1], '.') && isName(s[i - 2]) ? s[i - 2].v : null;
          const r = resolve(scope, q, s[i].v, false);
          if (r) notNull.add(`${r.src.alias}.${r.col.name}`.toLowerCase());
        }
      }
    }
    const outNames = new Set<string>();
    const start = w[1] === 'DISTINCT' || w[1] === 'ALL' ? 2 : 1;
    const list = selectList(s, start, listEnd, scope, envOf(scope, grouped, notNull), notNull, outNames);
    for (const [a, b] of found.conditions) clause(s, a, b, scope, outNames);
    clause(s, fromEnd, s.length, scope, outNames);
    const oneRow = !grouped && !w.slice(fromEnd).includes('HAVING') && list.exprs.length > 0 && list.exprs.length === list.outs.length && list.exprs.every(aggregates);
    return { outs: list.outs, scope: found.scope, ok: !list.unknown && errors() === errs, oneRow };
  };

  /** A compound's two parts as one: as many columns, a type they share; NULL as the operator lets it through. */
  const combine = (a: Shape, b: Shape, op: string): Shape | null => {
    if (a.outs.length !== b.outs.length) {
      problems.push({
        message: `the SELECTs on either side of ${op} give ${a.outs.length} and ${b.outs.length} columns`,
        help: `each SELECT in a UNION, INTERSECT or EXCEPT selects as many columns, in the same order`,
      });
      return null;
    }
    let ok = a.ok && b.ok;
    const outs = a.outs.map((x, j): Out => {
      const y = b.outs[j];
      if (op === 'EXCEPT') return x;
      const known = x.known && y.known;
      let type: SqlType = x.type;
      if (known && x.type !== y.type) {
        if (x.type === 'other' || y.type === 'other') type = 'other';
        else if (numeric(x.type) && numeric(y.type)) type = x.type === 'float' || y.type === 'float' ? 'float' : 'int';
        else if (op === 'UNION') {
          ok = false;
          problems.push({
            message: `\`${x.name}\` is ${typeName(x.type)} in one SELECT of this UNION and ${typeName(y.type)} (\`${y.label}\`) in another`,
            help: `make them one type: \`CAST(${y.label} AS ${x.type === 'string' ? 'TEXT' : x.type === 'float' ? 'REAL' : x.type === 'bytes' ? 'BLOB' : 'INTEGER'})\``,
          });
        }
      }
      // A UNION has both sides' rows; an INTERSECT's are in both.
      const nullable = op === 'UNION' ? x.nullable || y.nullable : x.nullable && y.nullable;
      const base = nullable && !x.nullable ? y : x;
      return { ...base, name: x.name, type, nullable, known };
    });
    return { outs, scope: [...a.scope, ...b.scope], ok, oneRow: false };
  };

  /** Card 139: names each of `ctes`, each seeing those before it; gives what they hid, for `unname`. */
  const nameCtes = (ctes: Cte[], outer: Source[]): Map<string, SqlTable | null | undefined> => {
    const hidden = new Map<string, SqlTable | null | undefined>();
    for (const c of ctes) {
      const key = c.name.toLowerCase();
      if (!hidden.has(key)) hidden.set(key, named.get(key));
      const was = recursed;
      recursed = false;
      building.add(key);
      const shape = select(c.body.inner ?? [], outer);
      building.delete(key);
      const self = recursed;
      recursed = was;
      let table: SqlTable | null = null;
      if (self) {
        note('it has a recursive WITH');
      } else if (shape?.ok) {
        const names = c.cols ?? shape.outs.map((o) => o.name);
        if (names.length !== shape.outs.length) {
          problems.push({
            message: `\`${c.name}\` names ${names.length} column${names.length === 1 ? '' : 's'}, and its query selects ${shape.outs.length}`,
            help: `name as many as it selects (${shape.outs.map((o) => o.name).join(', ')}), or leave the names out`,
          });
        } else {
          table = { name: c.name, where: '', columns: shape.outs.map((o, j) => ({ name: names[j], type: o.known ? o.type : 'other', nullable: o.nullable, required: false })) };
        }
      }
      named.set(key, table);
    }
    return hidden;
  };
  const unname = (hidden: Map<string, SqlTable | null | undefined>) => {
    for (const [key, t] of hidden) {
      if (t === undefined) named.delete(key);
      else named.set(key, t);
    }
  };

  /** A SELECT, or a compound of them with UNION [ALL], INTERSECT, EXCEPT; with a WITH before it. */
  const select = (s: Tok[], outer: Source[]): Shape | null => {
    if (upper(s[0]) === 'WITH') {
      const found = withClause(s, 0);
      if ('why' in found) {
        note(found.why);
        return null;
      }
      const hidden = nameCtes(found.ctes, outer);
      const shape = select(s.slice(found.next), outer);
      unname(hidden);
      return shape;
    }
    const parts: { op: string; toks: Tok[] }[] = [{ op: '', toks: [] }];
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (isP(s[i], '(')) depth++;
      if (isP(s[i], ')')) depth--;
      const u = upper(s[i]);
      if (depth === 0 && (u === 'UNION' || u === 'INTERSECT' || u === 'EXCEPT')) {
        parts.push({ op: u, toks: [] });
        if (u === 'UNION' && upper(s[i + 1]) === 'ALL') i++;
      } else {
        parts[parts.length - 1].toks.push(s[i]);
      }
    }
    if (parts.length === 1) return simpleSelect(s, outer);
    // ORDER BY and LIMIT after the last SELECT are the whole compound's.
    const last = parts[parts.length - 1];
    const tail = until(last.toks, 0, new Set(['ORDER', 'LIMIT']));
    const order = last.toks.slice(tail);
    last.toks = last.toks.slice(0, tail);
    let whole = simpleSelect(parts[0].toks, outer);
    const names = new Set(whole?.outs.map((o) => o.name.toLowerCase()));
    for (const part of parts.slice(1)) {
      const next = simpleSelect(part.toks, outer);
      for (const o of next?.outs ?? []) names.add(o.name.toLowerCase());
      // A SELECT with a mistake gives columns short: the counts would be a second, wrong error.
      whole = whole?.ok && next?.ok ? combine(whole, next, part.op) : null;
    }
    if (!whole) return null;
    if (upper(order[0]) === 'ORDER') {
      for (const term of commaSplit(order.slice(2, until(order, 2, new Set(['LIMIT']))))) {
        const t = term[0];
        if (!isName(t) || (term.length > 1 && !['ASC', 'DESC', 'COLLATE', 'NULLS'].includes(upper(term[1])))) continue;
        if (names.has(t.v.toLowerCase())) continue;
        whole.ok = false;
        problems.push({
          message: `this ${parts[1].op} is ordered by \`${t.v}\`, which isn't one of its columns`,
          help: `ORDER BY after a ${parts[1].op} names a column it gives (${whole.outs.map((o) => o.name).join(', ')}) or its number`,
        });
      }
    }
    return whole;
  };

  /** The rows `row` reads, against what the query gives. */
  const readInto = (outs: Out[], scope: Source[], ok: boolean) => {
    if (!row || !ok || errors() > 0) return;
    problems.push(...checkRow(outs, row, scope));
    for (const o of outs) {
      if (o.known) continue;
      problems.push({
        note: true,
        message: `this query's column \`${o.name}\` is not checked against the schema: the check doesn't know what \`${o.label}\` gives`,
        help: `a CAST names its type: \`CAST(${o.label} AS INTEGER)\``,
      });
    }
  };
  /** Card 137: `RETURNING ...` at `at` is a SELECT list on the table written; `sql.query` needs one to read rows. */
  const returning = (at: number, table: SqlTable, alias: string) => {
    if (at >= s.length) {
      if (row) problems.push({ message: `this ${kind} gives no rows to read`, help: 'add `RETURNING` with the columns to read, or run it with `sql.exec`' });
      return problems;
    }
    const scope: Source[] = [{ alias, table, outer: false, level: 0 }];
    const none = new Set<string>();
    const list = selectList(s, at + 1, s.length, scope, envOf(scope, false, none), none, new Set());
    readInto(list.outs, scope, !list.unknown);
    return problems;
  };
  /** `UPDATE t AS x`, `INSERT INTO t AS x`, `DELETE FROM t AS x`: the name the table goes by, and the index after. */
  const aliasAt = (i: number, table: SqlTable) => (w[i] === 'AS' && isName(s[i + 1]) ? { alias: s[i + 1].v, next: i + 2 } : { alias: bare(table.name), next: i });

  nameCtes(topCtes, []);
  if (kind === 'SELECT') {
    const shape = select(s, []);
    if (shape) readInto(shape.outs, shape.scope, shape.ok);
    return problems;
  }

  if (kind === 'INSERT' || kind === 'REPLACE') {
    const into = w.indexOf('INTO');
    if (into < 0) return [];
    const found = tableAt(s, into + 1);
    if (!found) return problems;
    const { table } = found;
    const { alias, next } = aliasAt(found.next, table);
    let i = next;
    let cols: SqlColumn[] = shown(table);
    const named = group(s, i);
    if (named) {
      cols = [];
      for (const c of commaSplit(named.inner)) {
        if (c.length !== 1 || !isName(c[0])) continue;
        const col = columnOf(table, c[0].v);
        if (col) cols.push(col);
      }
      i = named.next;
    }
    const ret = until(s, i, new Set(['RETURNING']));
    const on = w.findIndex((x, j) => j > i && j < ret && x === 'ON' && w[j + 1] === 'CONFLICT');
    const body = on >= 0 ? on : ret;
    if (w[i] === 'SELECT' || w[i] === 'WITH') {
      // Card 137: what the SELECT gives goes into the columns, in order.
      const shape = select(s.slice(i, body), []);
      if (shape?.ok) {
        if (shape.outs.length !== cols.length) {
          problems.push({ message: `this INSERT's SELECT gives ${shape.outs.length} columns for ${cols.length} columns of \`${table.name}\``, help: `the columns: ${cols.map((c) => c.name).join(', ')}` });
        } else {
          shape.outs.forEach((o, j) => {
            const col = cols[j];
            if (!o.known) return;
            if (!fits(o.type, col.type)) {
              problems.push({
                message: `\`${o.label}\` is ${typeName(o.type)}, and goes into \`${table.name}.${col.name}\`, which holds ${typeName(col.type)} (${table.where})`,
                help: textOrBytes(o.type, col.type) ?? 'select a value of the column\'s type, or CAST it',
              });
            } else if (o.nullable && !col.nullable) {
              problems.push({
                message: `\`${table.name}.${col.name}\` is NOT NULL, and \`${o.label}\` can be NULL (${table.where})`,
                help: `give a default: \`coalesce(${o.label}, ${zero[o.type]})\`, or make the column nullable in a migration`,
              });
            }
          });
        }
      }
    } else if (w[i] === 'VALUES') {
      i++;
      for (let tuple = group(s, i); tuple; tuple = s[tuple.next]?.v === ',' ? group(s, tuple.next + 1) : null) {
        const values = commaSplit(tuple.inner);
        for (const v of values) for (const t of v) if (t.k === 'sub') shapeOf(t, []);
        if (values.length !== cols.length) {
          problems.push({ message: `this INSERT gives ${values.length} values for ${cols.length} columns of \`${table.name}\``, help: `the columns: ${cols.map((c) => c.name).join(', ')}` });
          break;
        }
        values.forEach((v, j) => {
          if (v.length === 1) paramInto(v[0], table, cols[j], true);
        });
      }
    } else {
      // DEFAULT VALUES, or something the check doesn't read.
      return problems;
    }
    const missing = table.columns.filter((c) => c.required && !cols.includes(c));
    if (missing.length > 0) {
      problems.push({
        message: `this INSERT leaves out ${missing.map((c) => `\`${c.name}\``).join(', ')}, which \`${table.name}\` requires (NOT NULL, no DEFAULT; ${table.where})`,
        help: 'give a value for each, or give the column a DEFAULT in a migration',
      });
    }
    // ON CONFLICT (cols) DO UPDATE SET col = excluded.col, ... [WHERE ...]
    if (on >= 0) {
      let j = on + 2;
      const target = group(s, j);
      if (target) {
        for (const c of commaSplit(target.inner)) if (c.length === 1 && isName(c[0])) columnOf(table, c[0].v);
        j = target.next;
      }
      while (j < ret && w[j] !== 'DO') j++;
      if (w[j + 1] === 'UPDATE' && w[j + 2] === 'SET') {
        const scope: Source[] = [
          { alias, table, outer: false, level: 0 },
          { alias: 'excluded', table, outer: false, level: 0 },
        ];
        const end = until(s, j + 3, new Set(['WHERE', 'RETURNING']));
        assignments(s, j + 3, end, table, scope);
        clause(s, end, ret, scope, new Set());
      }
    }
    return returning(ret, table, alias);
  }

  if (kind === 'UPDATE') {
    const set = w.indexOf('SET');
    const found = tableAt(s, w[1] === 'OR' ? 3 : 1);
    if (!found || set < 0) return problems;
    const { table } = found;
    const { alias } = aliasAt(found.next, table);
    let scope: Source[] = [{ alias, table, outer: false, level: 0 }];
    const ret = until(s, set + 1, new Set(['RETURNING']));
    const fromAt = until(s, set + 1, new Set(['FROM', 'WHERE', 'RETURNING']));
    let where = fromAt;
    if (w[fromAt] === 'FROM') {
      // Card 137: UPDATE ... FROM reads other tables beside the one it writes.
      where = until(s, fromAt + 1, new Set(['WHERE', 'RETURNING']));
      const other = sources(s, fromAt + 1, where);
      if (!other) return problems;
      scope = [...scope, ...other.scope];
      for (const [a, b] of other.conditions) clause(s, a, b, scope, new Set());
    }
    assignments(s, set + 1, fromAt, table, scope);
    clause(s, where, ret, scope, new Set());
    return returning(ret, table, alias);
  }

  // DELETE FROM table [WHERE ...]
  const from = w.indexOf('FROM');
  const found = tableAt(s, from + 1);
  if (!found) return problems;
  const { alias, next } = aliasAt(found.next, found.table);
  const ret = until(s, next, new Set(['RETURNING']));
  clause(s, next, ret, [{ alias, table: found.table, outer: false, level: 0 }], new Set());
  return returning(ret, found.table, alias);
}

/** Reading a BLOB as text, or TEXT as Bytes. */
const readHelp = (col: SqlType, into: SqlType) =>
  col === 'bytes' && into === 'string'
    ? 'read it as `Bytes`, then `.toText()` gives the string if it is UTF-8'
    : col === 'string' && into === 'bytes'
      ? 'read it as a `string`; `.toBytes()` gives its bytes'
      : undefined;

/** A value of each type, for `coalesce(x, 0)` in help. */
const zero: Record<SqlType, string> = { int: '0', float: '0.0', string: "''", bool: '0', bytes: "x''", other: '...' };

/** Why `o` can be NULL, as a sentence's start. */
function nullable(o: Out): string {
  if (o.because === 'aggregate') return `\`${o.label}\` is NULL when no rows match`;
  if (o.because === 'outer') return `\`${o.label}\` is NULL where the outer join finds no row`;
  return `\`${o.label}\` can be NULL`;
}

/** The row type against the columns a query selects: by name, type and NULL. */
function checkRow(outs: Out[], row: RowShape, scope: Source[]): SqlProblem[] {
  const problems: SqlProblem[] = [];
  const fits = (field: SqlType, col: SqlType) =>
    field === 'other' || col === 'other' || field === col || (col === 'int' && field === 'bool') || (col === 'bool' && field === 'int') || (field === 'float' && col === 'int');
  const where = (o: Out) => (o.where ? ` (${o.where})` : '');
  const fallback = (o: Out) => `\`coalesce(${o.column ?? o.label}, ${zero[o.type]})\``;
  if (row.kind === 'one') {
    if (outs.length !== 1) {
      problems.push({ message: `this query selects ${outs.length} columns, but reads each row into one ${row.type}`, help: 'select one column, or read into a struct with `impl Row`' });
      return problems;
    }
    const o = outs[0];
    if (!o.known) return problems;
    if (!fits(row.type, o.type)) {
      const what = o.column ? `\`${o.column}\`, ${o.type === 'bytes' ? 'a BLOB' : typeName(o.type)} column,` : `\`${o.label}\`, ${typeName(o.type)},`;
      problems.push({ message: `this query reads ${what} into ${typeName(row.type)}${where(o)}`, help: readHelp(o.type, row.type) });
    } else if (o.nullable) {
      problems.push({
        message: `${nullable(o)}, and this query reads it into ${typeName(row.type)}${where(o)}`,
        help: `give a default: ${fallback(o)}; or read it into a struct with an optional field`,
      });
    }
    return problems;
  }
  const seen = new Set<string>();
  for (const o of outs) {
    const name = o.name.toLowerCase();
    if (seen.has(name)) problems.push({ message: `this query selects \`${o.name}\` twice`, help: o.column ? 'select it once, or name one: `t.col AS other`' : 'select it once' });
    seen.add(name);
    if (!row.fields.some((f) => f.name.toLowerCase() === name)) {
      const free = row.fields.find((f) => !outs.some((x) => x.name.toLowerCase() === f.name.toLowerCase()));
      problems.push({
        message: `this query selects \`${o.name}\`, and \`${row.name}\` has no field for it`,
        help: o.column || !free ? `leave it out, or add a field \`${o.name}\` to \`${row.name}\`` : `name it after a field: \`${o.label} AS ${free.name}\``,
      });
    }
  }
  for (const f of row.fields) {
    const o = outs.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    if (!o) {
      const anyHas = scope.some((x) => x.table.columns.some((c) => c.name.toLowerCase() === f.name.toLowerCase()));
      const nobody = scope.length === 1 ? `, which \`${scope[0].table.name}\` doesn't have yet` : ', which no table here has yet';
      problems.push({
        message: `\`${row.name}.${f.name}\` is read from a column \`${f.name}\`, which this query doesn't select`,
        help: `it selects ${outs.map((x) => x.name).join(', ')}; select \`${f.name}\` too${anyHas ? '' : nobody}`,
      });
      continue;
    }
    if (!o.known) continue;
    if (!fits(f.type, o.type)) {
      const holds = o.column ? `\`${o.label}\` holds ${o.type === 'int' ? 'ints' : o.type === 'bytes' ? 'Bytes' : `${o.type}s`}` : `\`${o.label}\` is ${typeName(o.type)}`;
      problems.push({ message: `\`${row.name}.${f.name}\` is ${typeName(f.type)}, but ${holds}${where(o)}`, help: readHelp(o.type, f.type) });
    } else if (o.nullable && !f.optional) {
      problems.push({
        message: `${nullable(o)}, so \`${row.name}.${f.name}\` must be optional${where(o)}`,
        help:
          o.because === 'column'
            ? `make the field \`${f.name}: ${f.type}?\`, or the column NOT NULL in a migration`
            : `make the field \`${f.name}: ${f.type}?\`, or give a default: ${fallback(o)}`,
      });
    }
  }
  return problems;
}
