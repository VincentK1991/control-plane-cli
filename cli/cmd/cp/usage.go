package main

import (
	"context"

	"github.com/spf13/cobra"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/output"
)

func newUsageCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "usage",
		Short: "View usage for the authenticated API key",
	}
	cmd.AddCommand(newUsageShowCmd())
	return cmd
}

func newUsageShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Show a usage summary",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			usage, err := c.Usage(context.Background())
			if err != nil {
				return err
			}

			format, err := outputFormat()
			if err != nil {
				return err
			}
			if format == output.JSON {
				return output.PrintJSON(cmd.OutOrStdout(), usage)
			}
			return output.PrintTable(cmd.OutOrStdout(),
				[]string{"TOTAL_EVENTS", "TOTAL_UNITS", "TOTAL_COST_CENTS"},
				[][]string{{usage.TotalEvents, usage.TotalUnits, usage.TotalCostCents}},
			)
		},
	}
}
