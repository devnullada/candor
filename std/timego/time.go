// Package timego is the Go under std/time.candor: calendar arithmetic on Candor's times, ints
// of milliseconds since the Unix epoch, always in UTC. Every function is pure.
package timego

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

func at(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

// Format is RFC 3339 with milliseconds, in UTC: 2026-10-25T10:00:00.000Z.
func Format(ms int64) string { return at(ms).Format("2006-01-02T15:04:05.000Z07:00") }

// FormatDate is the day alone: 2026-10-25.
func FormatDate(ms int64) string { return at(ms).Format("2006-01-02") }

// Parse reads RFC 3339 (any fraction of a second, `Z` or an offset like +02:00) or a date
// alone (midnight UTC), and says what is wrong with anything else.
func Parse(s string) (int64, error) {
	if len(s) == len("2006-01-02") {
		t, err := time.Parse("2006-01-02", s)
		if err != nil {
			return 0, why(s, err)
		}
		return t.UnixMilli(), nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, why(s, err)
	}
	return t.UnixMilli(), nil
}

func why(s string, err error) error {
	var pe *time.ParseError
	if errors.As(err, &pe) && pe.Message != "" {
		return fmt.Errorf("%q is not a time: %s", s, strings.TrimPrefix(pe.Message, ": "))
	}
	return fmt.Errorf("%q is not a time: write it as 2026-10-25T10:00:00Z (an offset like +02:00 for Z, a fraction of a second allowed) or 2026-10-25", s)
}

// Date is the time at those parts, in UTC. Valid says whether they name a real time.
func Date(year, month, day, hour, minute, second int64) int64 {
	return time.Date(int(year), time.Month(month), int(day), int(hour), int(minute), int(second), 0, time.UTC).UnixMilli()
}

func Valid(year, month, day, hour, minute, second int64) bool {
	t := time.Date(int(year), time.Month(month), int(day), int(hour), int(minute), int(second), 0, time.UTC)
	return int64(t.Year()) == year && int64(t.Month()) == month && int64(t.Day()) == day &&
		int64(t.Hour()) == hour && int64(t.Minute()) == minute && int64(t.Second()) == second
}

// AddMonths moves by whole months, keeping the time of day; a day past the new month's end
// becomes its last day (Jan 31 + 1 month is Feb 28, or 29).
func AddMonths(ms int64, n int64) int64 {
	t := at(ms)
	y, m := t.Year(), int(t.Month())-1+int(n)
	y += m / 12
	m %= 12
	if m < 0 {
		m += 12
		y--
	}
	last := time.Date(y, time.Month(m+2), 0, 0, 0, 0, 0, time.UTC).Day()
	d := min(t.Day(), last)
	return time.Date(y, time.Month(m+1), d, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC).UnixMilli()
}

// ParseDuration is Go's time.ParseDuration ("1m30s", "500ms", "-2h") in whole milliseconds; a
// part of one is dropped.
func ParseDuration(s string) (int64, error) {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration: write it as Go does, \"1m30s\", \"500ms\", \"2h\"", s)
	}
	return d.Milliseconds(), nil
}

// FormatDuration is Go's Duration.String: "1m30s", "500ms", "0s".
func FormatDuration(ms int64) string { return (time.Duration(ms) * time.Millisecond).String() }
