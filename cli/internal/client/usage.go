package client

import "context"

type UsageSummary struct {
	TotalEvents    string `json:"total_events"`
	TotalUnits     string `json:"total_units"`
	TotalCostCents string `json:"total_cost_cents"`
}

func (c *Client) Usage(ctx context.Context) (UsageSummary, error) {
	var body struct {
		Usage UsageSummary `json:"usage"`
	}
	err := c.get(ctx, "/api/v1/usage", &body)
	return body.Usage, err
}
