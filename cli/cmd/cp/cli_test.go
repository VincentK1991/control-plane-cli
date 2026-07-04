package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// runCLI executes a fresh root command with args against an isolated
// config dir and CP_API_KEY, returning combined stdout.
func runCLI(t *testing.T, apiURL string, args ...string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CP_API_KEY", "cp_live_test_key")
	t.Setenv("CP_API_URL", "")

	root := newRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	fullArgs := append([]string{"--api-url", apiURL}, args...)
	root.SetArgs(fullArgs)
	err := root.Execute()
	return out.String(), err
}

func TestVersionCommand(t *testing.T) {
	out, err := runCLI(t, "http://unused", "version")
	if err != nil {
		t.Fatalf("version command error = %v", err)
	}
	if strings.TrimSpace(out) != "dev" {
		t.Errorf("version output = %q, want %q", out, "dev")
	}
}

func TestAuthStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/me" {
			t.Errorf("path = %s, want /api/v1/me", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer cp_live_test_key" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		json.NewEncoder(w).Encode(map[string]string{
			"user_id": "u1", "api_key_id": "k1", "key_prefix": "cp_live_abc", "name": "test",
		})
	}))
	defer srv.Close()

	out, err := runCLI(t, srv.URL, "auth", "status")
	if err != nil {
		t.Fatalf("auth status error = %v", err)
	}
	if !strings.Contains(out, "k1") || !strings.Contains(out, "test") {
		t.Errorf("auth status output = %q, want it to contain key id and name", out)
	}
}

func TestAuthStatusUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid or revoked API key."})
	}))
	defer srv.Close()

	_, err := runCLI(t, srv.URL, "auth", "status")
	if err == nil {
		t.Fatal("expected an error when the API key is rejected")
	}
	if !strings.Contains(err.Error(), "Invalid or revoked API key") {
		t.Errorf("error = %v, want it to surface the server's message", err)
	}
}

func TestDBListTableAndJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"instances": []map[string]string{
				{"id": "i1", "name": "db1", "status": "ready", "tier": "free", "created_at": "2026-01-01"},
			},
		})
	}))
	defer srv.Close()

	table, err := runCLI(t, srv.URL, "db", "list")
	if err != nil {
		t.Fatalf("db list error = %v", err)
	}
	if !strings.Contains(table, "i1") || !strings.Contains(table, "ready") {
		t.Errorf("db list table output = %q", table)
	}

	jsonOut, err := runCLI(t, srv.URL, "--output", "json", "db", "list")
	if err != nil {
		t.Fatalf("db list --output json error = %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(jsonOut), &decoded); err != nil {
		t.Fatalf("db list --output json produced invalid JSON: %v\noutput: %s", err, jsonOut)
	}
	if len(decoded) != 1 || decoded[0]["id"] != "i1" {
		t.Errorf("decoded JSON = %+v", decoded)
	}
}

func TestDBCreateWithoutWaitReturnsImmediately(t *testing.T) {
	var callCount int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"instance": map[string]string{"id": "i1", "name": "my-db", "status": "provisioning", "tier": "free"},
		})
	}))
	defer srv.Close()

	out, err := runCLI(t, srv.URL, "db", "create", "--name", "my-db")
	if err != nil {
		t.Fatalf("db create error = %v", err)
	}
	if !strings.Contains(out, "provisioning") {
		t.Errorf("db create output = %q, want status provisioning (async by default)", out)
	}
	if callCount != 1 {
		t.Errorf("expected exactly 1 request without --wait, got %d", callCount)
	}
}

func TestDBCreateWithWaitPolls(t *testing.T) {
	var getCount int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]any{
				"instance": map[string]string{"id": "i1", "name": "my-db", "status": "provisioning", "tier": "free"},
			})
			return
		}
		getCount++
		status := "provisioning"
		if getCount >= 2 {
			status = "ready"
		}
		json.NewEncoder(w).Encode(map[string]any{
			"instance": map[string]string{"id": "i1", "name": "my-db", "status": status, "tier": "free"},
		})
	}))
	defer srv.Close()

	pollInterval = 0 // don't actually sleep in tests
	out, err := runCLI(t, srv.URL, "db", "create", "--name", "my-db", "--wait")
	if err != nil {
		t.Fatalf("db create --wait error = %v", err)
	}
	if !strings.Contains(out, "ready") {
		t.Errorf("db create --wait output = %q, want terminal status ready", out)
	}
	if getCount < 2 {
		t.Errorf("expected --wait to poll at least twice, got %d", getCount)
	}
}

func TestDBGetAndRm(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/databases/i1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			json.NewEncoder(w).Encode(map[string]any{
				"instance": map[string]string{"id": "i1", "status": "deleted"},
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"instance": map[string]string{"id": "i1", "name": "my-db", "status": "ready", "tier": "free"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	getOut, err := runCLI(t, srv.URL, "db", "get", "i1")
	if err != nil {
		t.Fatalf("db get error = %v", err)
	}
	if !strings.Contains(getOut, "ready") {
		t.Errorf("db get output = %q", getOut)
	}

	rmOut, err := runCLI(t, srv.URL, "db", "rm", "i1")
	if err != nil {
		t.Fatalf("db rm error = %v", err)
	}
	if !strings.Contains(rmOut, "deleted") {
		t.Errorf("db rm output = %q", rmOut)
	}
}

func TestDBGetNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Neo4j instance not found."})
	}))
	defer srv.Close()

	_, err := runCLI(t, srv.URL, "db", "get", "missing")
	if err == nil {
		t.Fatal("expected an error for a missing instance")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error = %v, want it to surface the server's message", err)
	}
}

func TestDocsIndexReadsStdinByDefault(t *testing.T) {
	var gotContent string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/databases/i1/documents", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		gotContent = body["content"]
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{"jobId": "j1"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CP_API_KEY", "cp_live_test_key")

	root := newRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetIn(strings.NewReader("hello from stdin"))
	root.SetArgs([]string{"--api-url", srv.URL, "docs", "index", "i1"})

	if err := root.Execute(); err != nil {
		t.Fatalf("docs index error = %v", err)
	}
	if gotContent != "hello from stdin" {
		t.Errorf("indexed content = %q, want %q", gotContent, "hello from stdin")
	}
	if !strings.Contains(out.String(), "j1") {
		t.Errorf("docs index output = %q, want job id j1", out.String())
	}
}

func TestDocsListAndStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/databases/i1/documents", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"jobs": []map[string]string{{"id": "j1", "status": "succeeded", "current_step": "recording-result"}},
		})
	})
	mux.HandleFunc("/api/v1/databases/i1/documents/j1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]string{"id": "j1", "status": "succeeded", "current_step": "recording-result"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	listOut, err := runCLI(t, srv.URL, "docs", "list", "i1")
	if err != nil {
		t.Fatalf("docs list error = %v", err)
	}
	if !strings.Contains(listOut, "j1") {
		t.Errorf("docs list output = %q", listOut)
	}

	statusOut, err := runCLI(t, srv.URL, "docs", "status", "i1", "j1")
	if err != nil {
		t.Fatalf("docs status error = %v", err)
	}
	if !strings.Contains(statusOut, "succeeded") {
		t.Errorf("docs status output = %q", statusOut)
	}
}

func TestUsageShow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"usage": map[string]string{"total_events": "5", "total_units": "20", "total_cost_cents": "100"},
		})
	}))
	defer srv.Close()

	out, err := runCLI(t, srv.URL, "usage", "show")
	if err != nil {
		t.Fatalf("usage show error = %v", err)
	}
	if !strings.Contains(out, "5") || !strings.Contains(out, "100") {
		t.Errorf("usage show output = %q", out)
	}
}

func TestMissingAPIKeyErrorsWithoutNetworkCall(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CP_API_KEY", "")

	root := newRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"--api-url", srv.URL, "db", "list"})

	err := root.Execute()
	if err == nil {
		t.Fatal("expected an error when no API key is configured")
	}
	if !strings.Contains(err.Error(), "not logged in") {
		t.Errorf("error = %v, want it to mention not being logged in", err)
	}
	if called {
		t.Error("server should never be called when there's no API key to send")
	}
}

func TestOutputFlagValidation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"instances": []any{}})
	}))
	defer srv.Close()

	_, err := runCLI(t, srv.URL, "--output", "yaml", "db", "list")
	if err == nil {
		t.Fatal("expected an error for an invalid --output value")
	}
	if !strings.Contains(err.Error(), "invalid --output") {
		t.Errorf("error = %v, want it to name the bad flag", err)
	}
}
