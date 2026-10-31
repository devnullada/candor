package candor

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

// SQL is the `sql` effect: one database, SQLite through database/sql. The driver is
// modernc.org/sqlite, which `std/sql.candor` imports for what it does when loaded, so programs
// without `import "sql"` don't build it.
type SQL struct {
	mu     sync.Mutex
	db     *sql.DB
	memory bool
	// What `sql.attach` attached: the source by lowercase name, so attaching it again is Ok.
	attached map[string]string
	// Under the test scheduler: the open transaction, and the tasks waiting for it to end. On
	// goroutines, the one connection makes them wait.
	owner   *sqlTx
	waiting []*simTask
	// What `sql.function` registered, in order, and how to open a database that has them.
	functions []NamedSQLFunction
	connector SQLConnector
}

// sqlTx is a transaction, open in the task that began it and the tasks that task spawns.
type sqlTx struct {
	mu   sync.Mutex
	tx   *sql.Tx
	task *core
	// Savepoints inside it, for their names.
	depth int
}

// runner is what a query runs on: the task's transaction, or the database.
type runner interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// RealSQL is the `sql` effect `main` gets: nothing is open until `sql.open`.
func RealSQL() *SQL { return &SQL{} }

// MemorySQL is the `sql` effect a test gets: SQLite in memory, opened on first use, and
// `sql.open` leaves it as it is.
func MemorySQL() *SQL { return &SQL{memory: true} }

// SQLQuery is `sql.Query`: a string literal with `?` where its `${...}` were, and their values.
type SQLQuery struct {
	Text string
	Args []any
}

// Open opens the database at source (a file, or ":memory:"), or gives why it couldn't.
func (s *SQL) Open(c *Ctx, source string) string {
	c.point()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.memory {
		return ""
	}
	if s.db != nil {
		return "the database is open already"
	}
	db, err := s.open(source)
	if err != nil {
		return err.Error()
	}
	s.db = db
	return ""
}

// Attach attaches the database at source as name, on the one connection, so it stays attached;
// in a test, a fresh one in memory. The same source as the same name again is Ok and changes
// nothing (a test's restart keeps its data, as `sql.open` does). Gives why it couldn't.
func (s *SQL) Attach(c *Ctx, source, name string) string {
	c.point()
	if c.tx != nil {
		return "sql.attach can't run inside a transaction"
	}
	s.await(c)
	db, why := s.conn()
	if why != "" {
		return why
	}
	key, where := strings.ToLower(name), sameFile(source)
	s.mu.Lock()
	had, ok := s.attached[key]
	s.mu.Unlock()
	if ok {
		if had == where {
			return ""
		}
		return fmt.Sprintf("%s is attached already, to %s: one name, one file", name, had)
	}
	if s.memory {
		source = ":memory:"
	}
	_, err := db.ExecContext(c.Context(), "ATTACH DATABASE ? AS ?", source, name)
	c.Check()
	if err != nil {
		return err.Error()
	}
	s.mu.Lock()
	if s.attached == nil {
		s.attached = map[string]string{}
	}
	s.attached[key] = where
	s.mu.Unlock()
	return ""
}

// sameFile is source as attach compares it: a file by its absolute path.
func sameFile(source string) string {
	if source == "" || strings.HasPrefix(source, ":") || strings.HasPrefix(source, "file:") {
		return source
	}
	if abs, err := filepath.Abs(source); err == nil {
		return abs
	}
	return source
}

// One connection: SQLite takes one writer at a time anyway, and an in-memory database is per
// connection. The ping makes a bad source fail at `open`, not at the first query.
// With functions registered, on a driver of their own (#b29bfb64), so a test's database has
// only the ones that test registered.
func (s *SQL) open(source string) (*sql.DB, error) {
	var db *sql.DB
	if len(s.functions) == 0 {
		var err error
		if db, err = sql.Open("sqlite", source); err != nil {
			return nil, err
		}
	} else {
		c, err := s.connector(source, s.functions)
		if err != nil {
			return nil, err
		}
		db = sql.OpenDB(c)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (s *SQL) conn() (*sql.DB, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil && s.memory {
		db, err := s.open(":memory:")
		if err != nil {
			return nil, err.Error()
		}
		s.db = db
	}
	if s.db == nil {
		return nil, "the database isn't open: call sql.open first"
	}
	return s.db, ""
}

// Exec runs q and gives how many rows it changed.
func (s *SQL) Exec(c *Ctx, q SQLQuery) (int64, string) {
	r, why := s.exec(c, q)
	if why != "" {
		return 0, why
	}
	n, err := r.RowsAffected()
	if err != nil {
		return 0, err.Error()
	}
	return n, ""
}

// Insert runs q and gives the id of the row it added.
func (s *SQL) Insert(c *Ctx, q SQLQuery) (int64, string) {
	r, why := s.exec(c, q)
	if why != "" {
		return 0, why
	}
	id, err := r.LastInsertId()
	if err != nil {
		return 0, err.Error()
	}
	return id, ""
}

// use gives what c's queries run on, and what to call when done with it. Under the test
// scheduler a task waits here while another task's transaction is open.
func (s *SQL) use(c *Ctx) (runner, func(), string) {
	if t := c.tx; t != nil {
		t.mu.Lock()
		return t.tx, t.mu.Unlock, ""
	}
	s.await(c)
	db, why := s.conn()
	return db, func() {}, why
}

func (s *SQL) await(c *Ctx) {
	if c.sim == nil {
		return
	}
	for s.owner != nil {
		c.sim.waitIn(&s.waiting, c.st, c.tok, "sql (another task's transaction)")
		c.Check()
	}
}

// Transaction runs f in a transaction: committed if f gives true; rolled back if it gives
// false, crashes or is cancelled. Inside another it is a savepoint. Gives why BEGIN or COMMIT
// failed.
func (s *SQL) Transaction(c *Ctx, f func() bool) string {
	c.point()
	if t := c.tx; t != nil {
		return t.savepoint(c, f)
	}
	s.await(c)
	db, why := s.conn()
	if why != "" {
		return why
	}
	tx, err := db.BeginTx(c.Context(), nil)
	c.Check()
	if err != nil {
		return err.Error()
	}
	t := &sqlTx{tx: tx, task: c.task}
	c.tx = t
	if c.sim != nil {
		s.owner = t
	}
	done := false
	defer func() {
		c.tx = nil
		if !done {
			tx.Rollback()
		}
		if c.sim != nil {
			s.owner = nil
			c.sim.wakeAll(&s.waiting)
		}
	}()
	ok := f()
	done = true
	if !ok {
		tx.Rollback()
		return ""
	}
	if err := tx.Commit(); err != nil {
		return err.Error()
	}
	return ""
}

func (t *sqlTx) savepoint(c *Ctx, f func() bool) string {
	if t.task != c.task {
		panic("candor: `sql.transaction` in a task spawned inside another transaction: the tasks share the outer one, so begin the inner one before spawning, or in the task that began the outer")
	}
	t.depth++
	defer func() { t.depth-- }()
	name := fmt.Sprintf("candor_%d", t.depth)
	// Run even when c is cancelled: undoing is what a cancel wants.
	run := func(stmt string) string {
		t.mu.Lock()
		defer t.mu.Unlock()
		if _, err := t.tx.ExecContext(context.Background(), stmt); err != nil {
			return err.Error()
		}
		return ""
	}
	if why := run("SAVEPOINT " + name); why != "" {
		return why
	}
	undo := func() {
		run("ROLLBACK TO " + name)
		run("RELEASE " + name)
	}
	done := false
	defer func() {
		if !done {
			undo()
		}
	}()
	ok := f()
	done = true
	if !ok {
		undo()
		return ""
	}
	return run("RELEASE " + name)
}

func (s *SQL) exec(c *Ctx, q SQLQuery) (sql.Result, string) {
	c.point()
	db, release, why := s.use(c)
	defer release()
	if why != "" {
		return nil, why
	}
	r, err := db.ExecContext(c.Context(), q.Text, q.Args...)
	c.Check()
	if err != nil {
		return nil, err.Error()
	}
	return r, ""
}

// Row is the dictionary `T: Row` passes: reads one row, given its column names, into a T.
type Row[T any] interface {
	FromRow(cols []string, vals []any) (T, string)
}

// SQLRows runs q and reads every row into a T.
func SQLRows[T any, D Row[T]](c *Ctx, s *SQL, q SQLQuery) ([]T, string) {
	c.point()
	db, release, why := s.use(c)
	defer release()
	if why != "" {
		return nil, why
	}
	rows, err := db.QueryContext(c.Context(), q.Text, q.Args...)
	c.Check()
	if err != nil {
		return nil, err.Error()
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err.Error()
	}
	out := []T{}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		c.Check()
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err.Error()
		}
		v, why := (*new(D)).FromRow(cols, vals)
		if why != "" {
			return nil, why
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err.Error()
	}
	return out, ""
}

// RowColumns checks that the columns are the fields of typeName, each once, in any order.
func RowColumns(cols []string, typeName string, fields ...string) string {
	want := map[string]bool{}
	for _, f := range fields {
		want[f] = true
	}
	seen := map[string]bool{}
	for _, c := range cols {
		if seen[c] {
			return fmt.Sprintf("column %q comes twice: name one with AS", c)
		}
		seen[c] = true
		if !want[c] {
			return fmt.Sprintf("column %q has no field in %s: leave it out, or name it with AS", c, typeName)
		}
	}
	var missing []string
	for _, f := range fields {
		if !seen[f] {
			missing = append(missing, fmt.Sprintf("%q", f))
		}
	}
	if len(missing) > 0 {
		return fmt.Sprintf("no column %s for %s: select %s", strings.Join(missing, ", "), typeName, them(len(missing)))
	}
	return ""
}

func them(n int) string {
	if n == 1 {
		return "it"
	}
	return "them"
}

// RowInt reads an integer column. ok is false for NULL, which only an optional field takes.
func RowInt(v any, col string) (n int64, ok bool, why string) {
	switch x := v.(type) {
	case nil:
		return 0, false, ""
	case int64:
		return x, true, ""
	case bool:
		if x {
			return 1, true, ""
		}
		return 0, true, ""
	}
	return 0, false, found(col, "an int", v)
}

// RowFloat reads a REAL column; an integer one reads too, as SQLite keeps 2.0 as 2.
func RowFloat(v any, col string) (f float64, ok bool, why string) {
	switch x := v.(type) {
	case nil:
		return 0, false, ""
	case float64:
		return x, true, ""
	case int64:
		return float64(x), true, ""
	}
	return 0, false, found(col, "a float", v)
}

// RowString reads a text column.
func RowString(v any, col string) (s string, ok bool, why string) {
	switch x := v.(type) {
	case nil:
		return "", false, ""
	case string:
		return x, true, ""
	case []byte:
		return string(x), true, ""
	}
	return "", false, found(col, "a string", v)
}

// RowBytes reads a BLOB column, or a TEXT one as its UTF-8 bytes: the check keeps a TEXT column
// from being read so, but a column with no declared type holds either. The driver's slice is a
// copy already; the cut keeps its capacity to its length, as Bytes are.
func RowBytes(v any, col string) (b []byte, ok bool, why string) {
	switch x := v.(type) {
	case nil:
		return nil, false, ""
	case []byte:
		return x[:len(x):len(x)], true, ""
	case string:
		return []byte(x), true, ""
	}
	return nil, false, found(col, "Bytes", v)
}

// RowBool reads a boolean column: SQLite keeps one as the integer 0 or 1.
func RowBool(v any, col string) (b bool, ok bool, why string) {
	switch x := v.(type) {
	case nil:
		return false, false, ""
	case bool:
		return x, true, ""
	case int64:
		if x == 0 || x == 1 {
			return x == 1, true, ""
		}
	}
	return false, false, found(col, "a bool (0 or 1)", v)
}

func found(col, want string, v any) string {
	switch x := v.(type) {
	case string:
		return fmt.Sprintf("column %q: expected %s, found %q", col, want, x)
	case float64:
		return fmt.Sprintf("column %q: expected %s, found the real number %v", col, want, x)
	case int64:
		return fmt.Sprintf("column %q: expected %s, found %d", col, want, x)
	}
	return fmt.Sprintf("column %q: expected %s, found %T", col, want, v)
}

// RowNull is the error for NULL in a column whose field isn't optional.
func RowNull(col, field string) string {
	return fmt.Sprintf("column %q is NULL, and %s isn't optional: make it `?`, or select a value", col, field)
}

// RowOfInt, RowOfString, RowOfBool, RowOfFloat and RowOfBytes are `Row` for a query of one column, whatever
// its name.
type RowOfInt struct{}
type RowOfFloat struct{}
type RowOfString struct{}
type RowOfBool struct{}
type RowOfBytes struct{}

func (RowOfInt) FromRow(cols []string, vals []any) (int64, string) {
	return one(cols, vals, "an int", RowInt)
}

func (RowOfFloat) FromRow(cols []string, vals []any) (float64, string) {
	return one(cols, vals, "a float", RowFloat)
}

func (RowOfString) FromRow(cols []string, vals []any) (string, string) {
	return one(cols, vals, "a string", RowString)
}

func (RowOfBool) FromRow(cols []string, vals []any) (bool, string) {
	return one(cols, vals, "a bool", RowBool)
}

func (RowOfBytes) FromRow(cols []string, vals []any) ([]byte, string) {
	return one(cols, vals, "Bytes", RowBytes)
}

func one[T any](cols []string, vals []any, what string, read func(any, string) (T, bool, string)) (T, string) {
	var zero T
	if len(cols) != 1 {
		return zero, fmt.Sprintf("expected one column, to read as %s, found %d", what, len(cols))
	}
	v, ok, why := read(vals[0], cols[0])
	if why != "" {
		return zero, why
	}
	if !ok {
		return zero, fmt.Sprintf("column %q is NULL, and the query reads %s", cols[0], what)
	}
	return v, ""
}

// SQLFunction is a Candor function given to `sql.function`: how many arguments it takes, and
// the generated call that reads them from SQLite's values and gives back its result, or why
// it couldn't.
type SQLFunction struct {
	Args int
	Call func(args []any) (any, string)
}

// NamedSQLFunction is a function `sql.function` registered, by its SQL name.
type NamedSQLFunction struct {
	Name string
	SQLFunction
}

// Run calls the function with SQLite's values, its failure as an error for the statement.
func (f NamedSQLFunction) Run(args []driver.Value) (driver.Value, error) {
	vals := make([]any, len(args))
	for i, a := range args {
		vals[i] = a
	}
	v, why := f.Call(vals)
	if why != "" {
		return nil, errors.New(why)
	}
	return v, nil
}

// SQLConnector opens source on a driver that has fns. The generated `sql.function` gives it,
// as the runtime doesn't import the driver (programs without `sql` don't build it).
type SQLConnector func(source string, fns []NamedSQLFunction) (driver.Connector, error)

// DriverConnector opens dsn with d, for sql.OpenDB.
func DriverConnector(d driver.Driver, dsn string) driver.Connector { return dsnConnector{d, dsn} }

type dsnConnector struct {
	d   driver.Driver
	dsn string
}

func (c dsnConnector) Connect(context.Context) (driver.Conn, error) { return c.d.Open(c.dsn) }
func (c dsnConnector) Driver() driver.Driver                        { return c.d }

// Function registers f as the SQL function name, before the database is open: SQLite gives a
// function to a connection when it opens. The database's driver is its own, so another
// database (another test's) has only what it registered. Gives why it couldn't.
func (s *SQL) Function(c *Ctx, name string, f SQLFunction, connector SQLConnector) string {
	c.point()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		if s.memory {
			return fmt.Sprintf("sql.function(%q, ...) comes after the test's first query: SQLite gives a function to a database as it opens, so register it before anything runs a query", name)
		}
		return fmt.Sprintf("sql.function(%q, ...) comes after sql.open: SQLite gives a function to a database as it opens, so register it first", name)
	}
	s.connector = connector
	for i, g := range s.functions {
		// The same name again (a helper called twice) replaces it.
		if strings.EqualFold(g.Name, name) {
			s.functions[i].SQLFunction = f
			return ""
		}
	}
	s.functions = append(s.functions, NamedSQLFunction{name, f})
	return ""
}

// SQLArg reads argument i of the SQL function name with read (RowInt, RowString, ...); ok is
// false for NULL.
func SQLArg[T any](name string, i int, v any, want string, read func(any, string) (T, bool, string)) (T, bool, string) {
	x, ok, why := read(v, "")
	if why != "" {
		got := fmt.Sprintf("%T", v)
		switch y := v.(type) {
		case string:
			got = fmt.Sprintf("the text %q", y)
		case int64:
			got = fmt.Sprintf("the integer %d", y)
		case float64:
			got = fmt.Sprintf("the real number %v", y)
		case []byte:
			got = "a BLOB"
		}
		return x, false, fmt.Sprintf("%s's argument %d: expected %s, found %s", name, i+1, want, got)
	}
	return x, ok, ""
}

// SQLArgNull is the error for NULL given to a parameter that isn't optional.
func SQLArgNull(name string, i int, param string) string {
	return fmt.Sprintf("%s's argument %d is NULL, and its parameter `%s` isn't optional: make it `T?`, or give a value with coalesce", name, i+1, param)
}

// SQLOut is a function's result as SQLite takes it: a bool as 0 or 1.
func SQLOut(v any) any {
	if b, ok := v.(bool); ok {
		if b {
			return int64(1)
		}
		return int64(0)
	}
	return v
}

// Show__ is how a failed `assert` prints a query: its text, with `?` for the parameters.
func (q SQLQuery) Show__() string { return fmt.Sprintf("%q", q.Text) }
