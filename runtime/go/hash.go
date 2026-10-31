package candor

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"hash"
	"io"
	"os"
)

// The `hash` module: digests and HMACs as Bytes, by the algorithm's name.
func hasher(algo string) func() hash.Hash {
	switch algo {
	case "sha1":
		return sha1.New
	case "sha256":
		return sha256.New
	case "sha512":
		return sha512.New
	case "md5":
		return md5.New
	}
	panic("unknown hash " + algo)
}

// Hash is the digest of b.
func Hash(algo string, b []byte) []byte {
	h := hasher(algo)()
	h.Write(b)
	return h.Sum(nil)
}

// Hmac is the HMAC of b under key.
func Hmac(algo string, key, b []byte) []byte {
	h := hmac.New(hasher(algo), key)
	h.Write(b)
	return h.Sum(nil)
}

// HashEqual compares in time that depends only on the lengths, for checking signatures.
func HashEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}

// HashFile is the digest of a file, read a piece at a time; in a test, of the file in memory.
func (f *FS) HashFile(c *Ctx, p, algo string) ([]byte, *FsErr) {
	c.point()
	if f.mem != nil {
		text, e := f.mem.read(p)
		if e != nil {
			return nil, e
		}
		return Hash(algo, []byte(text)), nil
	}
	src, err := os.Open(p)
	if err != nil {
		return nil, fsErr(p, err)
	}
	defer src.Close()
	if st, err := src.Stat(); err != nil {
		return nil, fsErr(p, err)
	} else if st.IsDir() {
		return nil, &FsErr{2, p, errIsDir.Error()}
	}
	h := hasher(algo)()
	if _, err := io.Copy(h, src); err != nil {
		return nil, fsErr(p, err)
	}
	return h.Sum(nil), nil
}
