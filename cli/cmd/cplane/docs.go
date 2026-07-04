package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/client"
	"github.com/vkieuvongngam/control-plane-cli/cli/internal/output"
)

func newDocsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "docs",
		Short: "Index documents into a database",
	}
	cmd.AddCommand(newDocsIndexCmd())
	cmd.AddCommand(newDocsListCmd())
	cmd.AddCommand(newDocsStatusCmd())
	return cmd
}

var terminalJobStatuses = map[string]bool{"succeeded": true, "failed": true}

func newDocsIndexCmd() *cobra.Command {
	var file string
	var wait bool

	cmd := &cobra.Command{
		Use:   "index <instance-id>",
		Short: "Start indexing a document (async by default)",
		Long: "Start indexing a document into the given database (async by default).\n\n" +
			"Content is read from --file, or from stdin if --file is omitted.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			instanceID := args[0]

			var content []byte
			var err error
			if file != "" {
				content, err = os.ReadFile(file)
			} else {
				content, err = io.ReadAll(cmd.InOrStdin())
			}
			if err != nil {
				return fmt.Errorf("reading document content: %w", err)
			}

			c, err := newClient()
			if err != nil {
				return err
			}

			ctx := context.Background()
			jobID, err := c.StartDocumentIndexing(ctx, instanceID, string(content))
			if err != nil {
				return err
			}

			job := client.DocumentJob{ID: jobID, Status: "queued"}
			if wait {
				job, err = pollJobUntilTerminal(ctx, c, instanceID, jobID)
				if err != nil {
					return err
				}
			}

			return printJob(cmd, job)
		},
	}

	cmd.Flags().StringVar(&file, "file", "", "Path to the document to index (default: read stdin)")
	cmd.Flags().BoolVar(&wait, "wait", false, "Block until the job reaches a terminal status (succeeded/failed)")
	return cmd
}

func newDocsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <instance-id>",
		Short: "List indexing jobs for a database",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			jobs, err := c.ListDocumentJobs(context.Background(), args[0])
			if err != nil {
				return err
			}

			format, err := outputFormat()
			if err != nil {
				return err
			}
			if format == output.JSON {
				return output.PrintJSON(cmd.OutOrStdout(), jobs)
			}

			rows := make([][]string, 0, len(jobs))
			for _, j := range jobs {
				rows = append(rows, []string{j.ID, j.Status, j.CurrentStep, j.UpdatedAt})
			}
			return output.PrintTable(cmd.OutOrStdout(), []string{"JOB_ID", "STATUS", "CURRENT_STEP", "UPDATED_AT"}, rows)
		},
	}
}

func newDocsStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <instance-id> <job-id>",
		Short: "Get the status of an indexing job",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := newClient()
			if err != nil {
				return err
			}

			job, err := c.GetDocumentJob(context.Background(), args[0], args[1])
			if err != nil {
				return err
			}
			return printJob(cmd, job)
		},
	}
}

func printJob(cmd *cobra.Command, job client.DocumentJob) error {
	format, err := outputFormat()
	if err != nil {
		return err
	}
	if format == output.JSON {
		return output.PrintJSON(cmd.OutOrStdout(), job)
	}
	return output.PrintTable(cmd.OutOrStdout(),
		[]string{"JOB_ID", "STATUS", "CURRENT_STEP"},
		[][]string{{job.ID, job.Status, job.CurrentStep}},
	)
}

func pollJobUntilTerminal(ctx context.Context, c *client.Client, instanceID, jobID string) (client.DocumentJob, error) {
	for {
		job, err := c.GetDocumentJob(ctx, instanceID, jobID)
		if err != nil {
			return client.DocumentJob{}, err
		}
		if terminalJobStatuses[job.Status] {
			return job, nil
		}
		select {
		case <-ctx.Done():
			return client.DocumentJob{}, fmt.Errorf("waiting for job %s: %w", jobID, ctx.Err())
		case <-time.After(pollInterval):
		}
	}
}
