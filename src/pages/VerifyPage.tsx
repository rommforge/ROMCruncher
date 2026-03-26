import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import FileInput from "../components/FileInput";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];

export default function VerifyPage() {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  const handleRun = useCallback(async () => {
    const args = ["verify", "-i", input];
    setLines([{ stream: "info", line: `> chdman ${args.join(" ")}` }]);
    setRunning(true);
    setExitStatus(null);

    const unlistenOutput = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setLines((prev) => [
        ...prev,
        { stream: e.payload.stream as OutputLine["stream"], line: e.payload.line },
      ]);
    });

    const unlistenProgress = await listen<number>("chdman-progress", (e) => {
      setJobProgress(e.payload);
    });

    setJobProgress(0);

    try {
      const code = await invoke<number>("run_chdman", { args });
      const ok = code === 0;
      setExitStatus(ok ? "success" : "error");
      setLines((prev) => [
        ...prev,
        {
          stream: ok ? "success" : "error",
          line: ok
            ? "✓ Verification passed — CHD is intact."
            : `✗ Verification failed (exit code ${code}).`,
        },
      ]);
    } catch (e) {
      setExitStatus("error");
      setLines((prev) => [...prev, { stream: "error", line: String(e) }]);
    } finally {
      unlistenOutput();
      unlistenProgress();
      setJobProgress(null);
      setRunning(false);
    }
  }, [input]);

  const handleCancel = () => invoke("cancel_chdman").catch(() => {});

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">Verify CHD</h1>
        <p className="page-subtitle">Check the integrity of a CHD file by verifying its SHA1 checksums.</p>
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
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRun} disabled={!input}>
            ▶ Verify
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>Cancel</button>
            <ProgressBar value={jobProgress} label="Verifying…" />
          </>
        )}
        {!running && exitStatus === "success" && <div className="status-badge success">✓ Passed</div>}
        {!running && exitStatus === "error"   && <div className="status-badge error">✗ Failed</div>}
      </div>

      <OutputLog lines={lines} onClear={() => setLines([])} />
    </div>
  );
}
