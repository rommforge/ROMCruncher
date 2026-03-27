import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import BatchFileList, { type FileEntry } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export default function InfoPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);
  const cancelledRef = useRef(false);

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function runOne(filePath: string): Promise<boolean> {
    const args = ["info", "-i", filePath, ...(verbose ? ["-v"] : [])];
    setLines((prev) => [...prev, { stream: "info", line: `> chdman ${args.join(" ")}` }]);

    const unlisten = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setLines((prev) => [...prev, { stream: e.payload.stream as OutputLine["stream"], line: e.payload.line }]);
    });

    try {
      const code = await invoke<number>("run_chdman", { args });
      const ok = code === 0;
      if (!ok) setLines((prev) => [...prev, { stream: "error", line: `Exit code ${code}` }]);
      return ok;
    } catch (e) {
      setLines((prev) => [...prev, { stream: "error", line: String(e) }]);
      return false;
    } finally {
      unlisten();
    }
  }

  async function handleRunAll() {
    cancelledRef.current = false;
    setRunning(true);
    setExitStatus(null);
    setLines([]);
    setProgress({ done: 0, total: files.length });
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" })));

    let allOk = true;

    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.current) break;
      const file = files[i];
      updateFileStatus(file.id, "running");
      setLines((prev) => [...prev, { stream: "info", line: `\n[${i + 1}/${files.length}] ${basename(file.path)}` }]);
      const ok = await runOne(file.path);
      updateFileStatus(file.id, ok ? "success" : "error");
      if (!ok) allOk = false;
      setProgress({ done: i + 1, total: files.length });
    }

    setRunning(false);
    setExitStatus(allOk ? "success" : "error");
  }

  const handleCancel = () => { cancelledRef.current = true; invoke("cancel_chdman").catch(() => {}); };

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">CHD Info</h1>
        <p className="page-subtitle">Display metadata and statistics for a CHD file.</p>
      </div>

      <div className="form-grid">
        <BatchFileList
          files={files}
          onChange={setFiles}
          filters={CHD_FILTERS}
          folderExtensions={["chd"]}
          disabled={running}
        />

        <label className="checkbox-group">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(e) => setVerbose(e.currentTarget.checked)}
            disabled={running}
          />
          <span className="checkbox-label">Verbose output (show hunk details)</span>
        </label>
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRunAll} disabled={files.length === 0}>
            ▶ Get Info {files.length > 1 ? `All (${files.length})` : ""}
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>Cancel</button>
            <ProgressBar value={null} label="Reading…" />
          </>
        )}
        {running && progress.total > 1 && (
          <span className="batch-progress">{progress.done} / {progress.total}</span>
        )}
        {!running && exitStatus === "success" && <div className="status-badge success">✓ Done</div>}
        {!running && exitStatus === "error"   && <div className="status-badge error">✗ Failed</div>}
      </div>

      <OutputLog lines={lines} onClear={() => setLines([])} />
    </div>
  );
}
