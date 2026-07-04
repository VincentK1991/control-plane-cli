package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/client"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/config"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/output"
)

var (
	flagAPIURL string
	flagOutput string
)

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "cp",
		Short:         "Control Plane CLI — provision databases, index documents, check usage",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.PersistentFlags().StringVar(&flagAPIURL, "api-url", "", "Control plane API base URL (default: "+config.DefaultAPIURL+")")
	root.PersistentFlags().StringVar(&flagOutput, "output", string(output.Table), `Output format: "table" or "json"`)

	root.AddCommand(newAuthCmd())
	root.AddCommand(newDBCmd())
	root.AddCommand(newDocsCmd())
	root.AddCommand(newUsageCmd())
	root.AddCommand(newVersionCmd())

	return root
}

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the CLI version",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Fprintln(cmd.OutOrStdout(), version)
			return nil
		},
	}
}

// outputFormat parses the global --output flag once per command run.
func outputFormat() (output.Format, error) {
	return output.ParseFormat(flagOutput)
}

// newClient resolves credentials (flag > env > config file) and builds an
// API client for the command to use. Every mutating/reading command should
// call this rather than touching config directly.
func newClient() (*client.Client, error) {
	resolved, err := config.Resolve(config.ResolveOptions{APIURLFlag: flagAPIURL})
	if err != nil {
		return nil, err
	}
	return client.New(resolved.APIURL, resolved.APIKey), nil
}

func main() {
	if err := newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
