package candor

import (
	"net/http"
	"strings"
	"sync"
)

// Socket is one end of a WebSocket connection: `http.upgrade` gives the server's end to its
// function as an `http.WebSocket`.
type Socket interface {
	// Send sends one message, or says the connection is closed.
	Send(c *Ctx, m SocketMessage) bool
	// Receive gives the next message, or false once the connection is closed.
	Receive(c *Ctx) (SocketMessage, bool)
	// Close closes this end; the other's Receive then gives false.
	Close(c *Ctx)
}

// SocketMessage is one WebSocket message: text, or with Binary, bytes (held in a string, as Go
// holds any).
type SocketMessage struct {
	Data   string
	Binary bool
}

// ReceiveText is `ws.receive()`: the next text message, skipping binary ones.
func ReceiveText(c *Ctx, s Socket) (string, bool) {
	for {
		m, ok := s.Receive(c)
		if !ok || !m.Binary {
			return m.Data, ok
		}
	}
}

// AcceptSocket upgrades a request to a WebSocket. std/http.candor's Go package (wsgo, on
// github.com/coder/websocket) sets it when loaded, so the runtime needs no dependency of its own.
var AcceptSocket func(c *Ctx, w http.ResponseWriter, r *http.Request) (Socket, error)

// The functions of upgrade responses, by id, as streams are: the Response holds the id.
var upgrades = struct {
	sync.Mutex
	m map[int64]func(*Ctx, Socket)
}{m: map[int64]func(*Ctx, Socket){}}

// PutUpgrade keeps f, the function `http.upgrade` was given, and gives its id.
func PutUpgrade(f func(*Ctx, Socket)) int64 {
	streams.Lock()
	streams.next++
	id := streams.next
	streams.Unlock()
	upgrades.Lock()
	defer upgrades.Unlock()
	upgrades.m[id] = f
	return id
}

// TakeUpgrade gives the function id holds and forgets it; nil if id is no upgrade.
func TakeUpgrade(id int64) func(*Ctx, Socket) {
	upgrades.Lock()
	defer upgrades.Unlock()
	f := upgrades.m[id]
	delete(upgrades.m, id)
	return f
}

// The client's ends of the WebSockets `http.dialSocket` opened, by id, until `Talk` takes them.
var sockets = struct {
	sync.Mutex
	m map[int64]Socket
}{m: map[int64]Socket{}}

// PutSocket keeps s, a connection the client opened, and gives its id.
func PutSocket(s Socket) int64 {
	streams.Lock()
	streams.next++
	id := streams.next
	streams.Unlock()
	sockets.Lock()
	defer sockets.Unlock()
	sockets.m[id] = s
	return id
}

// Talk is `http.connect`'s talking: f runs with the client's end of connection id, which closes
// when f returns. The id is a socket the client opened (`PutSocket`) or, from the fake, an
// upgrade response of the test's handler: that one runs in a task, the server's end of a
// connection in memory, and Talk waits for it to end too.
func Talk(c *Ctx, id int64, f func(*Ctx, Socket)) {
	upgrades.Lock()
	_, fake := upgrades.m[id]
	upgrades.Unlock()
	if fake {
		RunScope(c, func(c *Ctx, s *Scope) struct{} {
			client := SocketPair(c, s, id)
			defer client.Close(c)
			f(c, client)
			return struct{}{}
		}, nil)
		return
	}
	sockets.Lock()
	s := sockets.m[id]
	delete(sockets.m, id)
	sockets.Unlock()
	if s == nil {
		panic("candor: this WebSocket was talked over already")
	}
	defer s.Close(c)
	f(c, s)
}

// SocketPair is `http.socketOf`: the function of upgrade response id runs in a task of s, with
// one end of a connection in memory; the other end is the test's, to play the client.
func SocketPair(c *Ctx, s *Scope, id int64) Socket {
	f := TakeUpgrade(id)
	if f == nil {
		panic("candor: http.socketOf needs a response from http.upgrade, not yet connected")
	}
	p := &pair{}
	toServer := NewChannel[SocketMessage](c, s, 1024)
	toClient := NewChannel[SocketMessage](c, s, 1024)
	server := &pipeEnd{p: p, side: 0, in: toServer, out: toClient}
	client := &pipeEnd{p: p, side: 1, in: toClient, out: toServer}
	Spawn(c, s, func(c *Ctx) struct{} {
		defer server.Close(c)
		f(c, server)
		return struct{}{}
	}, nil)
	return client
}

// pair is a connection in memory: which ends have closed.
type pair struct {
	mu     sync.Mutex
	closed [2]bool
}

type pipeEnd struct {
	p       *pair
	side    int
	in, out *Channel[SocketMessage]
}

func (e *pipeEnd) Send(c *Ctx, m SocketMessage) (sent bool) {
	e.p.mu.Lock()
	open := !e.p.closed[0] && !e.p.closed[1]
	e.p.mu.Unlock()
	if !open {
		c.point()
		return false
	}
	// The send hands over the turn, and the end it writes to may close meanwhile: then it
	// wasn't sent, as on a real connection.
	defer func() {
		if p := recover(); p != nil {
			if s, ok := p.(string); ok && strings.HasSuffix(s, "on a Channel that is closed") {
				sent = false
				return
			}
			panic(p)
		}
	}()
	e.out.Send(c, m)
	return true
}

func (e *pipeEnd) Receive(c *Ctx) (SocketMessage, bool) {
	return e.in.Recv(c)
}

func (e *pipeEnd) Close(c *Ctx) {
	e.p.mu.Lock()
	already := e.p.closed[e.side]
	e.p.closed[e.side] = true
	e.p.mu.Unlock()
	if !already {
		e.out.Close(c)
	}
}
