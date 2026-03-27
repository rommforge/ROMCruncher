import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import BatchFileList, { type FileEntry } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";
import { buildReportLines, type ReportEntry } from "../components/JobReport";

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export default function VerifyPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);
  const cancelledRef = useRef(false);

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function verifyOne(filePath: string): Promise<boolean> {
    const args = ["verify", "-i", filePath];
    setLines((prev) => [...prev, { stream: "info", line: `> chdman ${args.join(" ")}` }]);
    setJobProgress(0);

    const unlistenOutput = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setLines((prev) => [...prev, { stream: e.payload.stream as OutputLine["stream"], line: e.payload.line }]);
    });
    const unlistenProgress = await listen<number>("chdman-progress", (e) => {
      setJobProgress(e.payload);
    });

    try {
      const code = await invoke<number>("run_chdman", { args });
      const ok = code === 0;
      setLines((prev) => [...prev, {
        stream: ok ? "success" : "error",
        line: ok ? "✓ Verification passed — CHD is intact." : `✗ Verification failed (exit code ${code}).`,
      }]);
      return ok;
    } catch (e) {
      setLines((prev) => [...prev, { stream: "error", line: String(e) }]);
      return false;
    } finally {
      unlistenOutput();
      unlistenProgress();
      setJobProgress(null);
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
    const reportEntries: ReportEntry[] = [];

    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.current) break;
      const file = files[i];
      updateFileStatus(file.id, "running");
      setLines((prev) => [...prev, { stream: "info", line: `\n[${i + 1}/${files.length}] ${basename(file.path)}` }]);
      const ok = await verifyOne(file.path);
      updateFileStatus(file.id, ok ? "success" : "error");
      if (!ok) allOk = false;
      reportEntries.push({ name: basename(file.path), ok, datStatus: "skipped" });
      setProgress({ done: i + 1, total: files.length });
    }

    if (reportEntries.length > 1) {
      setLines((prev) => [...prev, ...buildReportLines(reportEntries, false)]);
    }

    setRunning(false);
    setExitStatus(allOk ? "success" : "error");
  }

  const handleCancel = () => { cancelledRef.current = true; invoke("cancel_chdman").catch(() => {}); };

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">Verify CHD</h1>
        <p className="page-subtitle">Check the integrity of a CHD file by verifying its SHA1 checksums.</p>
      </div>

      <div className="form-grid">
        <BatchFileList
          files={files}
          onChange={setFiles}
          filters={CHD_FILTERS}
          folderExtensions={["chd"]}
          disabled={running}
        />
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRunAll} disabled={files.length === 0}>
            ▶ Verify {files.length > 1 ? `All (${files.length})` : ""}
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>Cancel</button>
            <ProgressBar value={jobProgress} label="Verifying…" />
          </>
        )}
        {running && progress.total > 1 && (
          <span className="batch-progress">{progress.done} / {progress.total}</span>
        )}
        {!running && exitStatus === "success" && <div className="status-badge success">✓ Passed</div>}
        {!running && exitStatus === "error"   && <div className="status-badge error">✗ Failed</div>}
      </div>

      <OutputLog lines={lines} onClear={() => setLines([])} />
    </div>
  );
}
