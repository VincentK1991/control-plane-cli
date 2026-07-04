package output

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseFormat(t *testing.T) {
	tests := []struct {
		in      string
		want    Format
		wantErr bool
	}{
		{"table", Table, false},
		{"json", JSON, false},
		{"yaml", "", true},
		{"", "", true},
	}
	for _, tt := range tests {
		got, err := ParseFormat(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParseFormat(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			continue
		}
		if !tt.wantErr && got != tt.want {
			t.Errorf("ParseFormat(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestPrintJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := PrintJSON(&buf, map[string]string{"id": "i1"}); err != nil {
		t.Fatalf("PrintJSON() error = %v", err)
	}
	if !strings.Contains(buf.String(), `"id": "i1"`) {
		t.Errorf("PrintJSON() output = %q", buf.String())
	}
}

func TestPrintTable(t *testing.T) {
	var buf bytes.Buffer
	err := PrintTable(&buf, []string{"ID", "NAME"}, [][]string{{"i1", "db1"}, {"i2", "db2"}})
	if err != nil {
		t.Fatalf("PrintTable() error = %v", err)
	}
	out := buf.String()
	for _, want := range []string{"ID", "NAME", "i1", "db1", "i2", "db2"} {
		if !strings.Contains(out, want) {
			t.Errorf("PrintTable() output missing %q:\n%s", want, out)
		}
	}
}

func TestPrintTableWithNoRows(t *testing.T) {
	var buf bytes.Buffer
	if err := PrintTable(&buf, []string{"ID", "NAME"}, nil); err != nil {
		t.Fatalf("PrintTable() error = %v", err)
	}
	if !strings.Contains(buf.String(), "ID") {
		t.Errorf("PrintTable() with no rows should still print headers, got %q", buf.String())
	}
}
