// Package sqlrows is Go written for Candor, bound in ../notes.candor. database/sql reads a row
// with Scan, which takes pointers; a binding can't pass those, so this reads one for it.
package sqlrows

import (
	"database/sql"
)

// Strings reads the row Next moved to, each column as a string (NULL as ""). On an error it
// closes the rows, so a caller that gives up early leaks nothing.
func Strings(rows *sql.Rows) ([]string, error) {
	cols, err := rows.Columns()
	if err != nil {
		rows.Close()
		return nil, err
	}
	values := make([]sql.NullString, len(cols))
	dest := make([]any, len(cols))
	for i := range values {
		dest[i] = &values[i]
	}
	if err := rows.Scan(dest...); err != nil {
		rows.Close()
		return nil, err
	}
	out := make([]string, len(cols))
	for i, v := range values {
		out[i] = v.String
	}
	return out, nil
}
