package timego

import (
	"fmt"
	"strings"
	"sync"
	"time"
	// The zone database goes into every program that imports time, so a zone name means the
	// same on any machine, with or without one installed.
	_ "time/tzdata"
)

var (
	zoneMu sync.Mutex
	zones  = map[string]*time.Location{}
)

// loc is the zone named name. A name reaching it passed ZoneOk, so it loads.
func loc(name string) *time.Location {
	if name == "UTC" {
		return time.UTC
	}
	// Only env.zone() makes a Zone with this name: a machine whose zone Go can't name.
	if name == "Local" {
		return time.Local
	}
	zoneMu.Lock()
	defer zoneMu.Unlock()
	if l, ok := zones[name]; ok {
		return l
	}
	l, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	zones[name] = l
	return l
}

// ZoneOk is whether name is a zone in the database: "Europe/Oslo", "America/New_York", "UTC".
// The machine's own zone ("Local", "") isn't one: it would make a pure function depend on
// where it runs.
func ZoneOk(name string) bool {
	if name == "" || name == "Local" {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

func atIn(ms int64, zone string) time.Time { return time.UnixMilli(ms).In(loc(zone)) }

// PartsIn is the calendar parts of ms in zone, in time.Parts' order, joined by commas (a
// binding can't give a List<int>). Weekday is ISO's: 1 for Monday to 7 for Sunday.
func PartsIn(ms int64, zone string) string {
	t := atIn(ms, zone)
	w := int(t.Weekday())
	if w == 0 {
		w = 7
	}
	return fmt.Sprintf("%d,%d,%d,%d,%d,%d,%d,%d,%d", t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(),
		t.Second(), t.Nanosecond()/1e6, w, t.YearDay())
}

// OffsetIn is how far zone's clocks are ahead of UTC at ms, in milliseconds.
func OffsetIn(ms int64, zone string) int64 {
	_, off := atIn(ms, zone).Zone()
	return int64(off) * 1000
}

// FormatIn is RFC 3339 with milliseconds and zone's offset: 2026-10-28T11:00:00.000+01:00.
func FormatIn(ms int64, zone string) string {
	return atIn(ms, zone).Format("2006-01-02T15:04:05.000Z07:00")
}

func FormatDateIn(ms int64, zone string) string { return atIn(ms, zone).Format("2006-01-02") }

// DateIn is the time at those parts on zone's clocks; a time the clocks show twice, when they
// go back, is the earlier (Go's time.Date doesn't say which), and one they skip, when they go
// forward, is moved on by the gap, as Go's time.Date does. ValidIn says whether the parts name
// a time: one skipped when the clocks go forward doesn't.
func DateIn(zone string, year, month, day, hour, minute, second int64) int64 {
	l := loc(zone)
	wall := time.Date(int(year), time.Month(month), int(day), int(hour), int(minute), int(second), 0, time.UTC)
	best := time.Date(int(year), time.Month(month), int(day), int(hour), int(minute), int(second), 0, l)
	// The offsets in use either side of the time; each that puts the clocks at the parts is a
	// reading of them.
	for _, near := range []time.Time{wall.Add(-24 * time.Hour), wall.Add(24 * time.Hour)} {
		_, off := near.In(l).Zone()
		u := wall.Add(-time.Duration(off) * time.Second)
		if u.In(l).Format(time.DateTime) == wall.Format(time.DateTime) && u.Before(best) {
			best = u
		}
	}
	return best.UnixMilli()
}

func ValidIn(zone string, year, month, day, hour, minute, second int64) bool {
	t := time.Date(int(year), time.Month(month), int(day), int(hour), int(minute), int(second), 0, loc(zone))
	return int64(t.Year()) == year && int64(t.Month()) == month && int64(t.Day()) == day &&
		int64(t.Hour()) == hour && int64(t.Minute()) == minute && int64(t.Second()) == second
}

// StartOfDayIn is the first moment of ms's day on zone's clocks: midnight, or the hour the
// clocks start at on a day they skip midnight.
func StartOfDayIn(ms int64, zone string) int64 {
	t := atIn(ms, zone)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()).UnixMilli()
}

// AddDaysIn is n days on (back if negative) at the same time on zone's clocks, so a day the
// clocks change is 23 or 25 hours long.
func AddDaysIn(ms int64, n int64, zone string) int64 {
	return atIn(ms, zone).AddDate(0, 0, int(n)).UnixMilli()
}

// DaysBetweenIn counts the midnights on zone's clocks from from to to.
func DaysBetweenIn(from, to int64, zone string) int64 {
	a, b := atIn(from, zone), atIn(to, zone)
	da := time.Date(a.Year(), a.Month(), a.Day(), 0, 0, 0, 0, time.UTC)
	db := time.Date(b.Year(), b.Month(), b.Day(), 0, 0, 0, 0, time.UTC)
	return int64(db.Sub(da).Hours() / 24)
}

// FormatLayout is ms in zone, written with Go's layout language.
func FormatLayout(ms int64, layout, zone string) string { return atIn(ms, zone).Format(layout) }

// ParseLayout reads text with Go's layout language. A time without a zone is on zone's clocks.
// A zone abbreviation is read from the table below; one not in it is read at offset 0, as Go
// does.
func ParseLayout(text, layout, zone string) (int64, error) {
	l := loc(zone)
	t, err := time.ParseInLocation(layout, text, l)
	if err != nil {
		var msg string
		if pe, ok := err.(*time.ParseError); ok && pe.Message != "" {
			msg = strings.TrimPrefix(pe.Message, ": ")
		} else {
			msg = fmt.Sprintf("it doesn't fit the layout %q", layout)
		}
		return 0, fmt.Errorf("%q is not a time: %s", text, msg)
	}
	name, off := t.Zone()
	if t.Location() == l || t.Location() == time.UTC || name == "" {
		return t.UnixMilli(), nil
	}
	// Go made up a zone for an abbreviation zone doesn't use, and read the clock time as UTC:
	// at offset 0, or GMT+2's offset without applying it.
	if strings.HasPrefix(name, "GMT") && off != 0 {
		return t.UnixMilli() - int64(off)*1000, nil
	}
	known, ok := abbreviations[name]
	if !ok {
		return t.UnixMilli(), nil
	}
	return t.UnixMilli() - int64(known)*60_000, nil
}

// abbreviations are the zone abbreviations dates are written with, in minutes ahead of UTC.
// Some are ambiguous; the table picks what US-centric feeds and mail mean: CST is US Central
// (not China), IST is India (not Ireland or Israel), BST is British Summer Time.
var abbreviations = map[string]int{
	"UTC": 0, "UT": 0, "GMT": 0, "Z": 0, "WET": 0,
	"EST": -300, "EDT": -240, "CST": -360, "CDT": -300, "MST": -420, "MDT": -360,
	"PST": -480, "PDT": -420, "AKST": -540, "AKDT": -480, "HST": -600, "HDT": -540,
	"AST": -240, "ADT": -180, "NST": -210, "NDT": -150,
	"BRT": -180, "ART": -180, "CLT": -240, "CLST": -180,
	"WEST": 60, "BST": 60, "CET": 60, "CEST": 120, "MET": 60, "MEST": 120,
	"EET": 120, "EEST": 180, "MSK": 180, "WAT": 60, "CAT": 120, "EAT": 180, "SAST": 120,
	"IST": 330, "PKT": 300, "NPT": 345, "ICT": 420, "WIB": 420, "WITA": 480, "WIT": 540,
	"HKT": 480, "SGT": 480, "PHT": 480, "KST": 540, "JST": 540,
	"AWST": 480, "ACST": 570, "ACDT": 630, "AEST": 600, "AEDT": 660,
	"NZST": 720, "NZDT": 780, "ChST": 600,
}
