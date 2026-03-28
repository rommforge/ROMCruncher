import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import FileInput from "../components/FileInput";

interface Settings {
  chdman_path: string;
  theme: string;
}

const THEMES = [
  { id: "dark",  label: "Dark" },
  { id: "light", label: "Light" },
  { id: "auto",  label: "System" },
];

function applyTheme(t: string) {
  document.documentElement.dataset.theme = t;
}

export default function Settings() {
  const [path, setPath] = useState("");
  const [theme, setTheme] = useState("auto");
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [chdmanVersion, setChdmanVersion] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      setPath(s.chdman_path);
      setTheme(s.theme || "auto");
      if (s.chdman_path.trim()) fetchVersion(s.chdman_path);
    }).catch(() => {});
  }, []);

  async function fetchVersion(p: string) {
    try {
      const v = await invoke<string>("get_chdman_version", { path: p });
      setChdmanVersion(v);
    } catch {
      setChdmanVersion(null);
    }
  }

  function handleThemeChange(t: string) {
    setTheme(t);
    applyTheme(t);
  }

  async function handleSave() {
    try {
      await invoke("save_settings", { settings: { chdman_path: path, theme } });
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 3000);
      if (path.trim()) fetchVersion(path);
      else setChdmanVersion(null);
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  return (
    <div className="page-wrapper">
    <div className="settings-section" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Configure ROMCruncher to find your chdman binary.</p>
      </div>

      <div className="settings-card">
        <div className="settings-card-title">chdman Binary</div>
        <div className="settings-card-desc">
          Point to the <code>chdman</code> executable on your system. On Windows this is{" "}
          <code>chdman.exe</code>; on macOS/Linux it has no extension. You can find it
          bundled with MAME or as a standalone download.
        </div>

        <FileInput
          label="Path to chdman"
          value={path}
          onChange={setPath}
          mode="open"
          filters={[
            { name: "Executable", extensions: ["exe", "*"] },
          ]}
          placeholder="e.g. C:\mame\chdman.exe"
          required
        />

        {chdmanVersion && (() => {
          const match = chdmanVersion.match(/\b0\.(\d+)\b/);
          const minor = match ? parseInt(match[1], 10) : null;
          const tooOld = minor !== null && minor < 264;
          return (
            <>
              <div className={`alert alert-${tooOld ? "warning" : "info"}`} style={{ marginTop: 10 }}>
                {tooOld ? "⚠" : "ℹ"} {chdmanVersion}
              </div>
              {tooOld && (
                <div className="alert alert-warning" style={{ marginTop: 6 }}>
                  ⚠ Version 0.264 or newer is required. Older versions are not compatible with MAME Redump DATs.
                </div>
              )}
            </>
          );
        })()}
      </div>

      <div className="settings-card">
        <div className="settings-card-title">Appearance</div>
        <div className="settings-card-desc">
          Choose a color theme. <strong>System</strong> follows your OS light/dark preference.
        </div>

        <div className="form-group">
          <label className="form-label">Theme</label>
          <div className="theme-selector">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-btn${theme === t.id ? " active" : ""}`}
                onClick={() => handleThemeChange(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-title">About ROMCruncher</div>
        <div className="settings-card-desc" style={{ marginBottom: 0 }}>
          A cross-platform GUI wrapper for <strong>chdman</strong> — the CHD (Compressed
          Hunks of Data) manager included with MAME. Supports creating and extracting
          CD-ROM, DVD, hard disk, and raw images in CHD format.
        </div>
      </div>

      <div className="actions-row" style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={!path.trim()}>
          Save
        </button>
        {status === "saved" && (
          <div className="alert alert-success">✓ Settings saved.</div>
        )}
        {status === "error" && (
          <div className="alert alert-error">✗ {errorMsg}</div>
        )}
      </div>
    </div>
    </div>
  );
}
