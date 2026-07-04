// Package config resolves CLI credentials and target API URL from, in
// order of precedence: flags, environment variables, then the on-disk
// config file. See docs/discussion/cli-tool.md ("Config & auth").
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	DefaultAPIURL = "https://api.controlplane.example.com"
	apiKeyEnvVar  = "CPLANE_API_KEY"
	apiURLEnvVar  = "CPLANE_API_URL"
)

// ErrNotLoggedIn is returned by Resolve when no API key can be found from
// any source.
var ErrNotLoggedIn = errors.New("not logged in: set CPLANE_API_KEY or run `cplane auth login`")

type FileConfig struct {
	APIKey string `json:"api_key"`
	APIURL string `json:"api_url,omitempty"`
}

// Path returns the on-disk config file location, honoring XDG_CONFIG_HOME
// when set.
func Path() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "cplane", "config.json"), nil
}

func Load() (FileConfig, error) {
	path, err := Path()
	if err != nil {
		return FileConfig{}, err
	}

	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return FileConfig{}, nil
	}
	if err != nil {
		return FileConfig{}, err
	}

	var cfg FileConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return FileConfig{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	return cfg, nil
}

// Save writes cfg to the config file with 0600 permissions, creating the
// parent directory if needed. The API key is a bearer credential, so the
// file must not be group/world readable.
func Save(cfg FileConfig) error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func Remove() error {
	path, err := Path()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Resolved is the fully-settled configuration for a single CLI invocation.
type Resolved struct {
	APIKey string
	APIURL string
}

// ResolveOptions carries flag values, which take precedence over env vars
// and the config file. Empty strings mean "flag not set."
type ResolveOptions struct {
	APIKeyFlag string
	APIURLFlag string
}

// Resolve determines the API key and base URL for this invocation, in order:
// flag > environment variable > config file > default (URL only).
func Resolve(opts ResolveOptions) (Resolved, error) {
	fileCfg, err := Load()
	if err != nil {
		return Resolved{}, err
	}

	apiKey := firstNonEmpty(opts.APIKeyFlag, os.Getenv(apiKeyEnvVar), fileCfg.APIKey)
	if apiKey == "" {
		return Resolved{}, ErrNotLoggedIn
	}

	apiURL := firstNonEmpty(opts.APIURLFlag, os.Getenv(apiURLEnvVar), fileCfg.APIURL, DefaultAPIURL)

	return Resolved{APIKey: apiKey, APIURL: apiURL}, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
