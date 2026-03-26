import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import FileInput from "../components/FileInput";

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];

export default function InfoPage() {
  const [input, setInput] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  async function handleRun() {
    const args = ["info", "-i", input, ...(verbose ? ["-v"] : [])];
    setOutput(`> chdman ${args.join(" ")}\n`);
    setRunning(true);
    setExitStatus(null);

    const unlisten = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setOutput((prev) => prev + e.payload.line + "\n");
    });

    try {
      const code = await invoke<number>("run_chdman", { args });
      const ok = code === 0;
      setExitStatus(ok ? "success" : "error");
      if (!ok) setOutput((prev) => prev + `\nProcess exited with code ${code}`);
    } catch (e) {
      setExitStatus("error");
      setOutput((prev) => prev + `\nError: ${String(e)}`);
    } finally {
      unlisten();
      setRunning(false);
    }
  }

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">CHD Info</h1>
        <p className="page-subtitle">Display metadata and statistics for a CHD file.</p>
      </div>

      <div className="form-grid">
        <FileInput
          label="CHD File"
          value={input}
          onChange={setInput}
          mode="open"
          filters={CHD_FILTERS}
          required
        />

        <label className="checkbox-group">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(e) => setVerbose(e.currentTarget.checked)}
          />
          <span className="checkbox-label">Verbose output (show hunk details)</span>
        </label>
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRun} disabled={!input}>
            ▶ Get Info
          </button>
        ) : (
          <div className="status-badge running"><div className="spinner" /> Reading…</div>
        )}
        {!running && exitStatus === "success" && <div className="status-badge success">✓ Done</div>}
        {!running && exitStatus === "error"   && <div className="status-badge error">✗ Failed</div>}
      </div>

      <pre className="info-output">
        {output
          ? output
          : <span className="info-placeholder">Select a CHD file and click Get Info…</span>
        }
      </pre>
    </div>
  );
}
