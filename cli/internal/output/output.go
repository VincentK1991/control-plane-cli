// Package output renders CLI results as either a human-readable table or
// raw JSON, selected by the global --output flag.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

type Format string

const (
	Table Format = "table"
	JSON  Format = "json"
)

func ParseFormat(s string) (Format, error) {
	switch Format(s) {
	case Table, JSON:
		return Format(s), nil
	default:
		return "", fmt.Errorf("invalid --output %q: must be %q or %q", s, Table, JSON)
	}
}

// PrintJSON writes v as indented JSON to w.
func PrintJSON(w io.Writer, v any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(v)
}

// PrintTable writes headers and rows as a whitespace-aligned table to w.
func PrintTable(w io.Writer, headers []string, rows [][]string) error {
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(headers, "\t"))
	for _, row := range rows {
		fmt.Fprintln(tw, strings.Join(row, "\t"))
	}
	return tw.Flush()
}
