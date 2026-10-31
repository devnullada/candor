package candor

import (
	crand "crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	mrand "math/rand/v2"
	"time"
)

// Random is the `random` effect. The real one draws from crypto/rand, so its ids and tokens can
// be secrets; the fake draws from a fixed seed, the same values in every run of a test.
type Random interface {
	// Int is in [low, high], both ends included.
	Int(c *Ctx, low, high int64) int64
	// Uuid is a version 7 UUID: the time in milliseconds, then random bits, so ids sort by
	// creation.
	Uuid(c *Ctx) string
	// Uuid4 is a version 4 UUID: all random bits, so nothing about it repeats or sorts (#c9d1ab04).
	Uuid4(c *Ctx) string
	// Token is that many random bytes, as hex.
	Token(c *Ctx, bytes int64) string
	// Bytes is that many random bytes: salts, nonces, keys.
	Bytes(c *Ctx, n int64) []byte
	// source draws the bits, for Shuffle and Pick; now is the time a UUID carries.
	source(c *Ctx) (*mrand.Rand, int64)
}

// SystemRandom returns the real `random` effect.
func SystemRandom() Random { return systemRandom{} }

type systemRandom struct{}

// cryptoSource is crypto/rand as a math/rand source, for its unbiased ranges and shuffle.
type cryptoSource struct{}

func (cryptoSource) Uint64() uint64 {
	var b [8]byte
	crand.Read(b[:])
	return binary.LittleEndian.Uint64(b[:])
}

var cryptoRand = mrand.New(cryptoSource{})

func (systemRandom) source(c *Ctx) (*mrand.Rand, int64) {
	return cryptoRand, time.Now().UnixMilli()
}

func (r systemRandom) Int(c *Ctx, low, high int64) int64 { return randInt(c, r, low, high) }
func (r systemRandom) Uuid(c *Ctx) string                { return uuid7(c, r) }
func (r systemRandom) Uuid4(c *Ctx) string               { return uuid4(c, r) }
func (r systemRandom) Token(c *Ctx, bytes int64) string  { return randToken(c, r, bytes) }

// Bytes reads crypto/rand directly, which never fails on the platforms Go supports.
func (systemRandom) Bytes(c *Ctx, n int64) []byte {
	c.point()
	checkByteCount(n)
	b := make([]byte, n)
	crand.Read(b)
	return b
}

// FakeRandom is the fake `random` effect: a generator seeded with 0 at the start of each test,
// or with what `random.seed(n)` gives. A UUID carries the virtual clock's time.
type FakeRandom struct {
	rng *mrand.Rand
}

func (f *FakeRandom) source(c *Ctx) (*mrand.Rand, int64) {
	if f.rng == nil {
		f.rng = mrand.New(mrand.NewPCG(0, 0))
	}
	return f.rng, c.sim.now
}

func (f *FakeRandom) Int(c *Ctx, low, high int64) int64 { return randInt(c, f, low, high) }
func (f *FakeRandom) Uuid(c *Ctx) string                { return uuid7(c, f) }
func (f *FakeRandom) Uuid4(c *Ctx) string               { return uuid4(c, f) }
func (f *FakeRandom) Token(c *Ctx, bytes int64) string  { return randToken(c, f, bytes) }
func (f *FakeRandom) Bytes(c *Ctx, n int64) []byte {
	c.point()
	checkByteCount(n)
	return randBytes(c, f, n)
}

// Seed starts the values over from another seed. Candor: `random.seed(n)`, in tests only.
func (f *FakeRandom) Seed(c *Ctx, n int64) {
	c.point()
	f.rng = mrand.New(mrand.NewPCG(uint64(n), 0))
}

func randInt(c *Ctx, r Random, low, high int64) int64 {
	c.point()
	if low > high {
		panic(fmt.Sprintf("random.int(%d, %d): low is above high", low, high))
	}
	rng, _ := r.source(c)
	// Unsigned, so the span of the whole int range doesn't overflow; 0 means all 2^64 values.
	span := uint64(high) - uint64(low) + 1
	if span == 0 {
		return int64(rng.Uint64())
	}
	return low + int64(rng.Uint64N(span))
}

func uuid7(c *Ctx, r Random) string {
	c.point()
	rng, now := r.source(c)
	var b [16]byte
	binary.BigEndian.PutUint64(b[8:], rng.Uint64())
	binary.BigEndian.PutUint64(b[0:], rng.Uint64())
	// 48 bits of milliseconds, then the version and variant over the random bits.
	ms := uint64(now)
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = 0x70 | b[6]&0x0f
	b[8] = 0x80 | b[8]&0x3f
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func uuid4(c *Ctx, r Random) string {
	c.point()
	rng, _ := r.source(c)
	var b [16]byte
	binary.BigEndian.PutUint64(b[0:], rng.Uint64())
	binary.BigEndian.PutUint64(b[8:], rng.Uint64())
	b[6] = 0x40 | b[6]&0x0f
	b[8] = 0x80 | b[8]&0x3f
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func randToken(c *Ctx, r Random, bytes int64) string {
	c.point()
	if bytes < 0 {
		panic(fmt.Sprintf("random.token(%d): the byte count cannot be negative", bytes))
	}
	return hex.EncodeToString(randBytes(c, r, bytes))
}

func checkByteCount(n int64) {
	if n < 0 {
		panic(fmt.Sprintf("random.bytes(%d): the byte count cannot be negative", n))
	}
}

// randBytes draws n bytes from r's source, eight at a time.
func randBytes(c *Ctx, r Random, n int64) []byte {
	rng, _ := r.source(c)
	b := make([]byte, (n+7)/8*8)
	for i := 0; i < len(b); i += 8 {
		binary.LittleEndian.PutUint64(b[i:], rng.Uint64())
	}
	return b[:n]
}

// Shuffle is `random.shuffle(xs)`: a new list, the items in a random order.
func Shuffle[T any](c *Ctx, r Random, xs []T) []T {
	c.point()
	rng, _ := r.source(c)
	out := append([]T{}, xs...)
	rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// Pick is `random.pick(xs)`: one item, or none from an empty list.
func Pick[T any](c *Ctx, r Random, xs []T) (T, bool) {
	c.point()
	if len(xs) == 0 {
		var zero T
		return zero, false
	}
	rng, _ := r.source(c)
	return xs[rng.IntN(len(xs))], true
}
