package client

import (
	"context"
	"net/url"
)

type DocumentJob struct {
	ID          string         `json:"id"`
	Status      string         `json:"status"`
	CurrentStep string         `json:"current_step"`
	Progress    map[string]any `json:"progress"`
	Error       string         `json:"error"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

func (c *Client) StartDocumentIndexing(ctx context.Context, instanceID, content string) (string, error) {
	var body struct {
		JobID string `json:"jobId"`
	}
	err := c.post(ctx, databasePath(instanceID, "/documents"), map[string]string{"content": content}, &body)
	return body.JobID, err
}

func (c *Client) ListDocumentJobs(ctx context.Context, instanceID string) ([]DocumentJob, error) {
	var body struct {
		Jobs []DocumentJob `json:"jobs"`
	}
	err := c.get(ctx, databasePath(instanceID, "/documents"), &body)
	return body.Jobs, err
}

func (c *Client) GetDocumentJob(ctx context.Context, instanceID, jobID string) (DocumentJob, error) {
	var body struct {
		Job DocumentJob `json:"job"`
	}
	err := c.get(ctx, databasePath(instanceID, "/documents/"+url.PathEscape(jobID)), &body)
	return body.Job, err
}
