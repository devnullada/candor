package bytesgo

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"strings"
)

// Unzip reads a zip archive held in memory: each file's name and inflated data, in the central
// directory's order, as name, data, name, data (a binding can't give a list of structs; the
// data is raw bytes in a string). Directories are left out. Stored and deflate entries only,
// each checked against its CRC-32, and no more than max bytes inflated in all.
func Unzip(data []byte, max int64) ([]string, error) {
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("not a zip archive, or cut short")
	}
	var out []string
	left := max
	for _, f := range r.File {
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		if f.Flags&0x1 != 0 {
			return nil, fmt.Errorf("%s is encrypted; Candor reads unencrypted entries", f.Name)
		}
		if f.Method != zip.Store && f.Method != zip.Deflate {
			return nil, fmt.Errorf("%s uses compression method %d%s; Candor reads stored (0) and deflate (8)", f.Name, f.Method, methodName(f.Method))
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("%s can't be read: the archive is damaged or cut short", f.Name)
		}
		// Read one past what is left, so an entry that would go over says so rather than being
		// cut; the header's size isn't trusted, the inflated bytes are counted.
		body, err := io.ReadAll(io.LimitReader(rc, left+1))
		rc.Close()
		if int64(len(body)) > left {
			return nil, fmt.Errorf("the archive inflates to more than %d bytes", max)
		}
		if err != nil {
			if errors.Is(err, zip.ErrChecksum) {
				return nil, fmt.Errorf("%s doesn't match its CRC-32: the archive is damaged", f.Name)
			}
			return nil, fmt.Errorf("%s can't be read: the archive is damaged or cut short", f.Name)
		}
		// archive/zip checks the CRC at the end of the data; a reader that stopped early hasn't.
		if crc32.ChecksumIEEE(body) != f.CRC32 {
			return nil, fmt.Errorf("%s doesn't match its CRC-32: the archive is damaged", f.Name)
		}
		left -= int64(len(body))
		out = append(out, f.Name, string(body))
	}
	return out, nil
}

func methodName(m uint16) string {
	switch m {
	case 9:
		return " (deflate64)"
	case 12:
		return " (bzip2)"
	case 14:
		return " (lzma)"
	case 93:
		return " (zstd)"
	case 95:
		return " (xz)"
	case 99:
		return " (AES encryption)"
	}
	return ""
}
