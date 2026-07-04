package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/client"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/output"
)

func newDBCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "db",
		Short: "Manage provisioned databases",
	}
	cmd.AddCommand(newDBCreateCmd())
	cmd.AddCommand(newDBListCmd())
	cmd.AddCommand(newDBGetCmd())
	cmd.AddCommand(newDBRmCmd())
	return cmd
}

var terminalDBStatuses = map[string]bool{"ready": true, "failed": true, "deleted": true}

func newDBCreateCmd() *cobra.Command {
	var name string
	var wait bool

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Provision a new database (async by default)",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			ctx := context.Background()
			result, err := c.CreateDatabase(ctx, name)
			if err != nil {
				return err
			}

			instance := result.Instance
			if wait && !terminalDBStatuses[instance.Status] {
				instance, err = pollDatabaseUntilTerminal(ctx, c, instance.ID)
				if err != nil {
					return err
				}
			}

			return printDatabase(cmd, instance)
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Database name (default: server-assigned)")
	cmd.Flags().BoolVar(&wait, "wait", false, "Block until the database reaches a terminal status (ready/failed)")
	return cmd
}

func newDBListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List databases for the authenticated API key",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			instances, err := c.ListDatabases(context.Background())
			if err != nil {
				return err
			}

			format, err := outputFormat()
			if err != nil {
				return err
			}
			if format == output.JSON {
				return output.PrintJSON(cmd.OutOrStdout(), instances)
			}

			rows := make([][]string, 0, len(instances))
			for _, i := range instances {
				rows = append(rows, []string{i.ID, i.Name, i.Status, i.Tier, i.CreatedAt})
			}
			return output.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "STATUS", "TIER", "CREATED_AT"}, rows)
		},
	}
}

func newDBGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <instance-id>",
		Short: "Get one database",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			instance, err := c.GetDatabase(context.Background(), args[0])
			if err != nil {
				return err
			}
			return printDatabase(cmd, instance)
		},
	}
}

func newDBRmCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rm <instance-id>",
		Short: "Delete a database",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			instance, err := c.DeleteDatabase(context.Background(), args[0])
			if err != nil {
				return err
			}
			return printDatabase(cmd, instance)
		},
	}
}

func printDatabase(cmd *cobra.Command, instance client.Database) error {
	format, err := outputFormat()
	if err != nil {
		return err
	}
	if format == output.JSON {
		return output.PrintJSON(cmd.OutOrStdout(), instance)
	}
	return output.PrintTable(cmd.OutOrStdout(),
		[]string{"ID", "NAME", "STATUS", "TIER", "BOLT_URL"},
		[][]string{{instance.ID, instance.Name, instance.Status, instance.Tier, instance.BoltURL}},
	)
}

// var, not const, so tests can shrink it to avoid real sleeps.
var pollInterval = 2 * time.Second

func pollDatabaseUntilTerminal(ctx context.Context, c *client.Client, instanceID string) (client.Database, error) {
	for {
		instance, err := c.GetDatabase(ctx, instanceID)
		if err != nil {
			return client.Database{}, err
		}
		if terminalDBStatuses[instance.Status] {
			return instance, nil
		}
		select {
		case <-ctx.Done():
			return client.Database{}, fmt.Errorf("waiting for database %s: %w", instanceID, ctx.Err())
		case <-time.After(pollInterval):
		}
	}
}
