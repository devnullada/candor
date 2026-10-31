package native

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Get fetches url and returns its body, up to 10 MB. A status other than 2xx is a *StatusError.
// The request is abandoned when ctx is cancelled.
func Get(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode/100 != 2 {
		return "", &StatusError{Code: resp.StatusCode}
	}
	return string(body), nil
}

// StatusError is an answer with a status other than 2xx.
type StatusError struct{ Code int }

func (e *StatusError) Error() string { return fmt.Sprintf("status %d", e.Code) }

// StatusOf is the HTTP status in err, or 0 if the server never answered.
func StatusOf(err error) int {
	var s *StatusError
	if errors.As(err, &s) {
		return s.Code
	}
	return 0
}
