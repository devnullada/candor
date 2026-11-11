// Package cryptogo is the Go under std/crypto.candor: AES-256-GCM from Go's crypto/aes and
// crypto/cipher, and argon2id from golang.org/x/crypto/argon2. Bytes cross as strings holding
// the raw bytes, as bindings pass strings.
package cryptogo

import (
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// NonceSize is the bytes of nonce std/crypto.candor puts before each sealed message.
const NonceSize = 12

// gcm is AES-256-GCM under key. Another length panics without showing the key, as a contract's
// failure would: AES-128 and -192 would take 16 or 24 bytes, but not as `crypto` promises.
func gcm(fn, key string) cipher.AEAD {
	if len(key) != 32 {
		panic(fmt.Sprintf("crypto.%s: the key is %d bytes; it must be 32, from crypto.deriveKey or random.bytes(32)", fn, len(key)))
	}
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return aead
}

// Seal encrypts and authenticates plain under a 32-byte key: the nonce, then the ciphertext and
// its 16-byte tag. The nonce is the caller's, fresh for every message.
func Seal(key, nonce, plain string) string {
	aead := gcm("seal", key)
	return string(aead.Seal([]byte(nonce), []byte(nonce), []byte(plain), nil))
}

// Open undoes Seal. A wrong key and changed bytes fail alike: GCM can't tell them apart.
func Open(key, sealed string) (string, error) {
	aead := gcm("open", key)
	if len(sealed) < NonceSize+aead.Overhead() {
		return "", errors.New("too short to be sealed")
	}
	plain, err := aead.Open(nil, []byte(sealed[:NonceSize]), []byte(sealed[NonceSize:]), nil)
	if err != nil {
		return "", errors.New("wrong key, or the bytes were changed")
	}
	return string(plain), nil
}

// DeriveKey is argon2id with the given costs, 32 bytes long: a key for Seal from a passphrase.
func DeriveKey(passphrase, salt string, time, memoryKiB, threads int64) string {
	return string(argon2.IDKey([]byte(passphrase), []byte(salt), uint32(time), uint32(memoryKiB), uint8(threads), 32))
}
