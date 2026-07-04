package config

import (
	"os"
	"path/filepath"
	"testing"
)

func withTempConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

func TestPathHonorsXDGConfigHome(t *testing.T) {
	dir := withTempConfigDir(t)
	path, err := Path()
	if err != nil {
		t.Fatalf("Path() error = %v", err)
	}
	want := filepath.Join(dir, "cplane", "config.json")
	if path != want {
		t.Errorf("Path() = %q, want %q", path, want)
	}
}

func TestLoadMissingFileReturnsZeroValue(t *testing.T) {
	withTempConfigDir(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.APIKey != "" || cfg.APIURL != "" {
		t.Errorf("Load() on missing file = %+v, want zero value", cfg)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	withTempConfigDir(t)
	want := FileConfig{APIKey: "cp_live_abc123", APIURL: "https://example.com"}

	if err := Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != want {
		t.Errorf("Load() = %+v, want %+v", got, want)
	}
}

func TestSaveWritesFileWithRestrictivePermissions(t *testing.T) {
	withTempConfigDir(t)
	if err := Save(FileConfig{APIKey: "cp_live_abc123"}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	path, _ := Path()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config file permissions = %o, want 0600 (it holds a bearer credential)", perm)
	}
}

func TestRemoveDeletesFileAndIsIdempotent(t *testing.T) {
	withTempConfigDir(t)
	if err := Save(FileConfig{APIKey: "cp_live_abc123"}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if err := Remove(); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() after Remove() error = %v", err)
	}
	if cfg.APIKey != "" {
		t.Errorf("Load() after Remove() = %+v, want zero value", cfg)
	}

	// Removing again (nothing left to remove) must not error.
	if err := Remove(); err != nil {
		t.Errorf("second Remove() error = %v, want nil", err)
	}
}

func TestResolvePrecedenceFlagBeatsEnvBeatsFileBeatsDefault(t *testing.T) {
	withTempConfigDir(t)

	t.Run("errors when nothing is configured", func(t *testing.T) {
		t.Setenv("CPLANE_API_KEY", "")
		t.Setenv("CPLANE_API_URL", "")
		_, err := Resolve(ResolveOptions{})
		if err != ErrNotLoggedIn {
			t.Errorf("Resolve() error = %v, want ErrNotLoggedIn", err)
		}
	})

	t.Run("config file is used when nothing else is set", func(t *testing.T) {
		if err := Save(FileConfig{APIKey: "from-file", APIURL: "https://file.example.com"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CPLANE_API_KEY", "")
		t.Setenv("CPLANE_API_URL", "")
		resolved, err := Resolve(ResolveOptions{})
		if err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
		if resolved.APIKey != "from-file" || resolved.APIURL != "https://file.example.com" {
			t.Errorf("Resolve() = %+v, want from-file config values", resolved)
		}
	})

	t.Run("env var overrides config file", func(t *testing.T) {
		if err := Save(FileConfig{APIKey: "from-file", APIURL: "https://file.example.com"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CPLANE_API_KEY", "from-env")
		t.Setenv("CPLANE_API_URL", "https://env.example.com")
		resolved, err := Resolve(ResolveOptions{})
		if err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
		if resolved.APIKey != "from-env" || resolved.APIURL != "https://env.example.com" {
			t.Errorf("Resolve() = %+v, want from-env values", resolved)
		}
	})

	t.Run("flag overrides env var and config file", func(t *testing.T) {
		if err := Save(FileConfig{APIKey: "from-file", APIURL: "https://file.example.com"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CPLANE_API_KEY", "from-env")
		t.Setenv("CPLANE_API_URL", "https://env.example.com")
		resolved, err := Resolve(ResolveOptions{APIKeyFlag: "from-flag", APIURLFlag: "https://flag.example.com"})
		if err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
		if resolved.APIKey != "from-flag" || resolved.APIURL != "https://flag.example.com" {
			t.Errorf("Resolve() = %+v, want from-flag values", resolved)
		}
	})

	t.Run("falls back to default API URL when nothing sets it", func(t *testing.T) {
		if err := Save(FileConfig{APIKey: "from-file"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CPLANE_API_KEY", "")
		t.Setenv("CPLANE_API_URL", "")
		resolved, err := Resolve(ResolveOptions{})
		if err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
		if resolved.APIURL != DefaultAPIURL {
			t.Errorf("APIURL = %q, want default %q", resolved.APIURL, DefaultAPIURL)
		}
	})
}
