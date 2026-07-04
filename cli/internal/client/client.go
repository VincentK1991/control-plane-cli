// Package client is a thin REST client over the control plane's bearer-
// scoped /api/v1 surface (see docs/discussion/cli-tool.md). It has no
// business logic — every method is one HTTP call plus JSON decoding.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// requestTimeout applies to every /api/v1 call uniformly. This is safe to
// keep short: POST /databases now returns as soon as the row is created
// (status "provisioning") — the server runs Kubernetes provisioning in the
// background rather than blocking the response on it — so no request in
// this client legitimately takes long. `cplane db create --wait` polls
// GET /databases/{id} instead of relying on one long-lived call.
const requestTimeout = 30 * time.Second

func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: requestTimeout,
		},
	}
}

// APIError is returned for any non-2xx response. The control plane's error
// responses are always {"error": "message"}.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s (status %d)", e.Message, e.StatusCode)
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
		reqBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	// Always set Content-Type, even on bodyless requests (DELETE): the
	// server's built-in cross-site-request-forgery check treats requests
	// with no Content-Type as a possible form submission and rejects
	// non-GET methods outright. See docs/discussion/cli-tool.md.
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("calling %s %s: %w", method, path, err)
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var errBody struct {
			Error string `json:"error"`
		}
		message := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &errBody) == nil && errBody.Error != "" {
			message = errBody.Error
		}
		return &APIError{StatusCode: res.StatusCode, Message: message}
	}

	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decoding response from %s %s: %w", method, path, err)
	}
	return nil
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

func (c *Client) delete(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodDelete, path, nil, out)
}
