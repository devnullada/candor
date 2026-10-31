// Package native blocks until its context ends, to show that a task's cancellation reaches Go.
package native

import (
	"context"
	"fmt"
	"time"
)

// Wait returns after ms milliseconds, or as soon as ctx is cancelled.
func Wait(ctx context.Context, ms int64) (int64, error) {
	select {
	case <-time.After(time.Duration(ms) * time.Millisecond):
		return ms, nil
	case <-ctx.Done():
		fmt.Println("Go saw the cancellation:", ctx.Err())
		return 0, ctx.Err()
	}
}
