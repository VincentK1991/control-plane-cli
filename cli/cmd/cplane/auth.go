package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/config"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/output"
)

func newAuthCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage the locally stored API key",
	}
	cmd.AddCommand(newAuthLoginCmd())
	cmd.AddCommand(newAuthLogoutCmd())
	cmd.AddCommand(newAuthStatusCmd())
	return cmd
}

func newAuthLoginCmd() *cobra.Command {
	var keyFlag string

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Store an API key minted from the dashboard",
		Long: "Store an API key minted from the dashboard.\n\n" +
			"API keys themselves are only ever created or revoked in the dashboard — " +
			"this command just saves one locally so other `cplane` commands can use it.",
		RunE: func(cmd *cobra.Command, args []string) error {
			key := keyFlag
			if key == "" {
				key = os.Getenv("CPLANE_API_KEY")
			}
			if key == "" {
				fmt.Fprint(cmd.OutOrStdout(), "Paste your API key: ")
				reader := bufio.NewReader(cmd.InOrStdin())
				line, err := reader.ReadString('\n')
				if err != nil && line == "" {
					return fmt.Errorf("reading API key: %w", err)
				}
				key = strings.TrimSpace(line)
			}
			if key == "" {
				return fmt.Errorf("no API key provided (use --key, CPLANE_API_KEY, or paste one at the prompt)")
			}

			cfg, err := config.Load()
			if err != nil {
				return err
			}
			cfg.APIKey = key
			if flagAPIURL != "" {
				cfg.APIURL = flagAPIURL
			}
			if err := config.Save(cfg); err != nil {
				return err
			}

			path, _ := config.Path()
			fmt.Fprintf(cmd.OutOrStdout(), "Saved API key to %s\n", path)
			return nil
		},
	}

	cmd.Flags().StringVar(&keyFlag, "key", "", "API key value (otherwise reads CPLANE_API_KEY or prompts)")
	return cmd
}

func newAuthLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove the locally stored API key",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := config.Remove(); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Removed locally stored API key.")
			return nil
		},
	}
}

func newAuthStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Confirm the stored API key is valid",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			me, err := c.Me(context.Background())
			if err != nil {
				return err
			}

			format, err := outputFormat()
			if err != nil {
				return err
			}
			if format == output.JSON {
				return output.PrintJSON(cmd.OutOrStdout(), me)
			}
			return output.PrintTable(cmd.OutOrStdout(),
				[]string{"API_KEY_ID", "NAME", "PREFIX", "USER_ID"},
				[][]string{{me.APIKeyID, me.Name, me.KeyPrefix, me.UserID}},
			)
		},
	}
}
