package client

import "context"

type Me struct {
	UserID    string `json:"user_id"`
	APIKeyID  string `json:"api_key_id"`
	KeyPrefix string `json:"key_prefix"`
	Name      string `json:"name"`
}

func (c *Client) Me(ctx context.Context) (Me, error) {
	var me Me
	err := c.get(ctx, "/api/v1/me", &me)
	return me, err
}
