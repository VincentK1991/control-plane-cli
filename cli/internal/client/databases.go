package client

import (
	"context"
	"fmt"
	"net/url"
)

type Database struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Status          string   `json:"status"`
	Tier            string   `json:"tier"`
	BoltURL         string   `json:"bolt_url"`
	HTTPURL         string   `json:"http_url"`
	ExternalBoltURL string   `json:"external_bolt_url"`
	ExternalHTTPURL string   `json:"external_http_url"`
	Plugins         []string `json:"plugins"`
	LastError       string   `json:"last_error"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
}

type DatabaseCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type CreateDatabaseResult struct {
	Instance    Database             `json:"instance"`
	Credentials *DatabaseCredentials `json:"credentials"`
}

func (c *Client) ListDatabases(ctx context.Context) ([]Database, error) {
	var body struct {
		Instances []Database `json:"instances"`
	}
	err := c.get(ctx, "/api/v1/databases", &body)
	return body.Instances, err
}

func (c *Client) CreateDatabase(ctx context.Context, name string) (CreateDatabaseResult, error) {
	var result CreateDatabaseResult
	reqBody := map[string]string{}
	if name != "" {
		reqBody["name"] = name
	}
	err := c.post(ctx, "/api/v1/databases", reqBody, &result)
	return result, err
}

func (c *Client) GetDatabase(ctx context.Context, instanceID string) (Database, error) {
	var body struct {
		Instance Database `json:"instance"`
	}
	err := c.get(ctx, "/api/v1/databases/"+url.PathEscape(instanceID), &body)
	return body.Instance, err
}

func (c *Client) DeleteDatabase(ctx context.Context, instanceID string) (Database, error) {
	var body struct {
		Instance Database `json:"instance"`
	}
	err := c.delete(ctx, "/api/v1/databases/"+url.PathEscape(instanceID), &body)
	return body.Instance, err
}

func databasePath(instanceID, suffix string) string {
	return fmt.Sprintf("/api/v1/databases/%s%s", url.PathEscape(instanceID), suffix)
}
