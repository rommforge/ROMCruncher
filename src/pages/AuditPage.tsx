import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import ProgressBar from "../components/ProgressBar";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import { type ReportEntry } from "../components/JobReport";
import { useDat, type DatInfo } from "../context/DatContext";

export default function AuditPage() {
  const { datIndex, datInfos, parseErrors, loading, refreshDats } = useDat();

  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [currentFile, setCurrentFile] = useState("");
  const cancelledRef = useRef(false);

  async function handleAddFiles() {
    const result = await open({
      multiple: true,
      filters: [{ name: "CHD / Disc Images", extensions: ["chd", "cue", "gdi", "iso", "bin", "img", "raw", "avi"] }],
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    setFilePaths((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
  }

  async function handleAddFolder() {
    const result = await open({ directory: true, multiple: false });
    if (!result || Array.isArray(result)) return;
    setScanning(true);
    try {
      const found = await invoke<string[]>("scan_folder", {
        dir: result,
        extensions: ["chd", "cue", "gdi", "iso", "bin", "img", "raw", "avi"],
      }).catch(() => [] as string[]);
      setFilePaths((prev) => [...prev, ...found.filter((p) => !prev.includes(p))]);
    } finally {
      setScanning(false);
    }
  }

  function removeFile(path: string) {
    setFilePaths((prev) => prev.filter((p) => p !== path));
  }

  async function auditOne(filePath: string): Promise<{ status: "match" | "no-match" | "error"; gameName?: string; datFile?: string; message?: string }> {
    const isChd = filePath.split(".").pop()?.toLowerCase() === "chd";
    try {
      let match;
      if (isChd) {
        const sha1 = await invoke<string>("get_chd_data_sha1", { path: filePath });
        match = datIndex.get(sha1);
      } else {
        const unlistenHash = await listen<number>("hash-progress", (e) => setJobProgress(e.payload));
        setJobProgress(0);
        try {
          const hashes = await invoke<{ sha1: string; crc32: string }>("hash_file", { path: filePath });
          match = datIndex.get(hashes.sha1) ?? datIndex.get(hashes.crc32);
        } finally {
          unlistenHash();
          setJobProgress(null);
        }
      }
      if (match) return { status: "match", gameName: match.gameName, datFile: match.datFile };
      return { status: "no-match" };
    } catch (e) {
      return { status: "error", message: String(e) };
    }
  }

  async function handleRunAudit() {
    if (datIndex.size === 0) return;
    cancelledRef.current = false;
    setRunning(true);
    setLines([]);
    setProgress({ done: 0, total: filePaths.length });

    const reportEntries: ReportEntry[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      if (cancelledRef.current) break;
      const p = filePaths[i];
      const name = p.replace(/\\/g, "/").split("/").pop() ?? p;
      setCurrentFile(name);
      setLines((prev) => [...prev, { stream: "info", line: `[${i + 1}/${filePaths.length}] ${name}` }]);

      const result = await auditOne(p);

      if (result.status === "match") {
        setLines((prev) => [...prev, { stream: "success", line: `  ✓ ${result.gameName} [${result.datFile}]` }]);
        reportEntries.push({ name, ok: true, datStatus: "match", gameName: result.gameName, datFile: result.datFile });
      } else if (result.status === "no-match") {
        setLines((prev) => [...prev, { stream: "error", line: `  – No match in any DAT` }]);
        reportEntries.push({ name, ok: false, datStatus: "no-match" });
      } else {
        setLines((prev) => [...prev, { stream: "error", line: `  ✗ ${result.message}` }]);
        reportEntries.push({ name, ok: false, datStatus: "error" });
      }

      setProgress({ done: i + 1, total: filePaths.length });
    }

    if (reportEntries.length > 1) {
      const matched   = reportEntries.filter((e) => e.datStatus === "match").length;
      const unmatched = reportEntries.filter((e) => e.datStatus !== "match").length;
      const failed    = reportEntries.filter((e) => e.datStatus !== "match");
      const summary: OutputLine[] = [
        { stream: "info", line: "\n" + "─".repeat(60) },
        { stream: unmatched > 0 ? "error" : "success", line: `  ${matched} matched · ${unmatched} unmatched` },
      ];
      if (failed.length > 0) {
        summary.push({ stream: "info", line: "\n  Unmatched files:" });
        for (const e of failed) {
          summary.push({ stream: "error", line: `    – ${e.name}` });
        }
      }
      setLines((prev) => [...prev, ...summary]);
    }

    setRunning(false);
    setCurrentFile("");
  }

  const handleCancel = () => { cancelledRef.current = true; };

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">DAT Audit</h1>
        <p className="page-subtitle">Verify CHD or disc image files against loaded DAT databases.</p>
      </div>

      {/* DAT files panel */}
      <div className="audit-dats-panel">
        <div className="audit-dats-header">
          <span className="form-section-title" style={{ marginBottom: 0 }}>
            Loaded DATs {loading ? "(loading…)" : `(${datInfos.length})`}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={refreshDats} disabled={loading}>
            ↺ Refresh
          </button>
        </div>
        {parseErrors.length > 0 && (
          <div className="audit-parse-errors">
            {parseErrors.map((e, i) => (
              <div key={i} className="audit-parse-error">⚠ {e}</div>
            ))}
          </div>
        )}
        {datInfos.length === 0 && parseErrors.length === 0 && (
          <p className="audit-dats-empty">
            No DAT files found. Place <code>.dat</code> or <code>.xml</code> files in the <code>dat/</code> folder next to the app executable.
          </p>
        )}
        {datInfos.length > 0 && (
          <div className="audit-dat-list">
            {datInfos.map((d: DatInfo) => (
              <div key={d.filePath} className="audit-dat-item">
                <span className="audit-dat-name">{d.headerName || d.fileName}</span>
                <span className="audit-dat-meta">{d.entryCount.toLocaleString()} entries · {d.headerVersion || "no version"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* File picker */}
      <div className="form-group">
        <div className="file-list-actions">
          <button className="btn btn-ghost btn-sm" onClick={handleAddFiles} disabled={running}>+ Add Files…</button>
          <button className="btn btn-ghost btn-sm" onClick={handleAddFolder} disabled={running || scanning}>{scanning ? "Scanning…" : "+ Add Folder…"}</button>
          {filePaths.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setFilePaths([])} disabled={running}>Clear All</button>
          )}
        </div>
        <div className="file-list">
          {filePaths.length === 0 ? (
            <div className="file-list-empty">No files selected</div>
          ) : (
            filePaths.map((p) => (
              <div key={p} className="file-list-item">
                <span className="file-path" title={p}>{p}</span>
                <button className="file-remove-btn" onClick={() => removeFile(p)} disabled={running}>×</button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="actions-row">
        {!running ? (
          <button
            className="btn btn-primary"
            onClick={handleRunAudit}
            disabled={filePaths.length === 0 || datIndex.size === 0}
          >
            ▶ Audit {filePaths.length > 1 ? `All (${filePaths.length})` : ""}
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>Cancel</button>
            <ProgressBar value={jobProgress} label={currentFile || "Auditing…"} />
          </>
        )}
        {running && progress.total > 1 && (
          <span className="batch-progress">{progress.done} / {progress.total}</span>
        )}
        {datIndex.size === 0 && !loading && (
          <span className="audit-no-dat-warn">No DATs loaded — add DAT files to the dat/ folder</span>
        )}
      </div>

      <OutputLog lines={lines} onClear={() => setLines([])} />
    </div>
  );
}
