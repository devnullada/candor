// Package wsgo is the Go under `http.upgrade` in std/http.candor: WebSockets on
// github.com/coder/websocket. Loading it hands the runtime its way to accept one.
package wsgo

import (
	"context"
	"fmt"
	"net/http"
	"time"

	candor "candor.dev/runtime"
	"github.com/coder/websocket"
)

// maxMessage is the largest message received; a larger one closes the connection.
const maxMessage = 1 << 20

func init() { candor.AcceptSocket = accept }

// Ready is bound in std/http.candor, so every program that imports `http` loads this package.
func Ready() bool { return candor.AcceptSocket != nil }

func accept(c *candor.Ctx, w http.ResponseWriter, r *http.Request) (candor.Socket, error) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(maxMessage)
	return &socket{conn: conn}, nil
}

// Dial opens a WebSocket to target (ws://, wss://, or http:// and https://) and gives its id in
// the runtime's socket table, for `candor.Talk`. headers are flat name, value pairs, sent with
// Set; more are the repeats, sent with Add. timeoutMs bounds the handshake only.
func Dial(ctx context.Context, target string, headers []string, more []string, timeoutMs int64) (int64, error) {
	if timeoutMs < 0 {
		return 0, fmt.Errorf("timeoutMs is %d: give it a positive number of milliseconds, or 0 for no timeout", timeoutMs)
	}
	if timeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()
	}
	h := http.Header{}
	for i := 0; i+1 < len(headers); i += 2 {
		h.Set(headers[i], headers[i+1])
	}
	for i := 0; i+1 < len(more); i += 2 {
		h.Add(more[i], more[i+1])
	}
	// A `host` header is the Host sent, as for http.send.
	host := h.Get("Host")
	h.Del("Host")
	conn, res, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: h, Host: host})
	if err != nil {
		if res != nil && res.StatusCode != http.StatusSwitchingProtocols {
			return 0, fmt.Errorf("%s answered %d, not a WebSocket", target, res.StatusCode)
		}
		return 0, err
	}
	conn.SetReadLimit(maxMessage)
	return candor.PutSocket(&socket{conn: conn}), nil
}

type socket struct{ conn *websocket.Conn }

func (s *socket) Send(c *candor.Ctx, m candor.SocketMessage) bool {
	c.Check()
	typ := websocket.MessageText
	if m.Binary {
		typ = websocket.MessageBinary
	}
	return s.conn.Write(c.Context(), typ, []byte(m.Data)) == nil
}

func (s *socket) Receive(c *candor.Ctx) (candor.SocketMessage, bool) {
	typ, b, err := s.conn.Read(c.Context())
	if err != nil {
		c.Check()
		return candor.SocketMessage{}, false
	}
	return candor.SocketMessage{Data: string(b), Binary: typ == websocket.MessageBinary}, true
}

func (s *socket) Close(c *candor.Ctx) {
	s.conn.Close(websocket.StatusNormalClosure, "")
}
