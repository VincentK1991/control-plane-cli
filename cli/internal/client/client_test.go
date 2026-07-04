package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestServer(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL, "cp_live_test_key"), srv
}

func TestMe(t *testing.T) {
	var gotAuth, gotContentType, gotMethod, gotPath string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotMethod = r.Method
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(Me{UserID: "u1", APIKeyID: "k1", KeyPrefix: "cp_live_abc", Name: "test key"})
	})

	me, err := c.Me(context.Background())
	if err != nil {
		t.Fatalf("Me() error = %v", err)
	}
	if me.UserID != "u1" || me.APIKeyID != "k1" {
		t.Errorf("Me() = %+v, want user_id=u1 api_key_id=k1", me)
	}
	if gotAuth != "Bearer cp_live_test_key" {
		t.Errorf("Authorization header = %q, want bearer test key", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type header = %q, want application/json (required even on GET, see client.go)", gotContentType)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/v1/me" {
		t.Errorf("request = %s %s, want GET /api/v1/me", gotMethod, gotPath)
	}
}

func TestListDatabases(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"instances": []Database{
				{ID: "i1", Name: "db1", Status: "ready", Tier: "free"},
				{ID: "i2", Name: "db2", Status: "provisioning", Tier: "free"},
			},
		})
	})

	instances, err := c.ListDatabases(context.Background())
	if err != nil {
		t.Fatalf("ListDatabases() error = %v", err)
	}
	if len(instances) != 2 || instances[0].ID != "i1" || instances[1].Status != "provisioning" {
		t.Errorf("ListDatabases() = %+v", instances)
	}
}

func TestCreateDatabase(t *testing.T) {
	var gotMethod, gotContentType string
	var gotBody map[string]string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(CreateDatabaseResult{
			Instance:    Database{ID: "i1", Name: "my-db", Status: "ready", Tier: "free"},
			Credentials: &DatabaseCredentials{Username: "neo4j", Password: "secret"},
		})
	})

	result, err := c.CreateDatabase(context.Background(), "my-db")
	if err != nil {
		t.Fatalf("CreateDatabase() error = %v", err)
	}
	if result.Instance.ID != "i1" || result.Credentials.Username != "neo4j" {
		t.Errorf("CreateDatabase() = %+v", result)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %s, want POST", gotMethod)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}
	if gotBody["name"] != "my-db" {
		t.Errorf("request body name = %q, want my-db", gotBody["name"])
	}
}

func TestGetDatabase(t *testing.T) {
	var gotPath string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(map[string]any{
			"instance": Database{ID: "i1", Name: "db1", Status: "ready"},
		})
	})

	instance, err := c.GetDatabase(context.Background(), "i1")
	if err != nil {
		t.Fatalf("GetDatabase() error = %v", err)
	}
	if instance.ID != "i1" {
		t.Errorf("GetDatabase() = %+v", instance)
	}
	if gotPath != "/api/v1/databases/i1" {
		t.Errorf("path = %q, want /api/v1/databases/i1", gotPath)
	}
}

func TestDeleteDatabase(t *testing.T) {
	var gotMethod, gotContentType string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		json.NewEncoder(w).Encode(map[string]any{
			"instance": Database{ID: "i1", Status: "deleted"},
		})
	})

	instance, err := c.DeleteDatabase(context.Background(), "i1")
	if err != nil {
		t.Fatalf("DeleteDatabase() error = %v", err)
	}
	if instance.Status != "deleted" {
		t.Errorf("DeleteDatabase() = %+v", instance)
	}
	if gotMethod != http.MethodDelete {
		t.Errorf("method = %s, want DELETE", gotMethod)
	}
	// Regression test: Astro's built-in CSRF check rejects state-changing
	// requests (observed specifically on DELETE) that have no Content-Type
	// header, even bodyless ones — see docs/discussion/cli-tool.md and the
	// client's do() comment.
	if gotContentType != "application/json" {
		t.Errorf("Content-Type on DELETE = %q, want application/json", gotContentType)
	}
}

func TestDocumentIndexingFlow(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/databases/i1/documents", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["content"] != "hello" {
				t.Errorf("POST body content = %q, want hello", body["content"])
			}
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{"jobId": "j1"})
		case http.MethodGet:
			json.NewEncoder(w).Encode(map[string]any{
				"jobs": []DocumentJob{{ID: "j1", Status: "succeeded"}},
			})
		}
	})
	mux.HandleFunc("/api/v1/databases/i1/documents/j1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"job": DocumentJob{ID: "j1", Status: "succeeded", CurrentStep: "recording-result"},
		})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "cp_live_test_key")

	jobID, err := c.StartDocumentIndexing(context.Background(), "i1", "hello")
	if err != nil {
		t.Fatalf("StartDocumentIndexing() error = %v", err)
	}
	if jobID != "j1" {
		t.Errorf("jobID = %q, want j1", jobID)
	}

	job, err := c.GetDocumentJob(context.Background(), "i1", "j1")
	if err != nil {
		t.Fatalf("GetDocumentJob() error = %v", err)
	}
	if job.Status != "succeeded" {
		t.Errorf("job.Status = %q, want succeeded", job.Status)
	}

	jobs, err := c.ListDocumentJobs(context.Background(), "i1")
	if err != nil {
		t.Fatalf("ListDocumentJobs() error = %v", err)
	}
	if len(jobs) != 1 || jobs[0].ID != "j1" {
		t.Errorf("ListDocumentJobs() = %+v", jobs)
	}
}

func TestUsage(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"usage": UsageSummary{TotalEvents: "3", TotalUnits: "10", TotalCostCents: "500"},
		})
	})

	usage, err := c.Usage(context.Background())
	if err != nil {
		t.Fatalf("Usage() error = %v", err)
	}
	if usage.TotalEvents != "3" {
		t.Errorf("Usage() = %+v", usage)
	}
}

func TestErrorResponse(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Neo4j instance not found."})
	})

	_, err := c.GetDatabase(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected an error for 404 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if apiErr.StatusCode != http.StatusNotFound {
		t.Errorf("StatusCode = %d, want 404", apiErr.StatusCode)
	}
	if apiErr.Message != "Neo4j instance not found." {
		t.Errorf("Message = %q", apiErr.Message)
	}
}

func TestUnauthorized(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid or revoked API key."})
	})

	_, err := c.Me(context.Background())
	if err == nil {
		t.Fatal("expected an error for 401 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("error = %v, want *APIError with status 401", err)
	}
}
