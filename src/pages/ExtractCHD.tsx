import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BatchFileList, { type FileEntry, ARCHIVE_EXTS } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";

type MediaType = "cd" | "dvd" | "hd" | "raw";

const TABS: { id: MediaType; label: string }[] = [
  { id: "cd",  label: "CD-ROM" },
  { id: "dvd", label: "DVD-ROM" },
  { id: "hd",  label: "Hard Disk" },
  { id: "raw", label: "Raw" },
];

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];
const OUTPUT_EXT: Record<MediaType, string> = { cd: ".cue", dvd: ".iso", hd: ".raw", raw: ".raw" };

interface ArchiveContents { temp_dir: string; files: string[] }

function isArchive(path: string) {
  return ARCHIVE_EXTS.includes(path.split(".").pop()?.toLowerCase() ?? "");
}

function sep(path: string) { return path.includes("\\") ? "\\" : "/"; }

function dirOf(path: string): string {
  const s = sep(path);
  const idx = path.lastIndexOf(s);
  return idx >= 0 ? path.substring(0, idx) : "";
}

function basenameNoExt(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function outputPath(inputPath: string, ext: string, outDir: string): string {
  const dir = outDir || dirOf(inputPath);
  const s = sep(dir || inputPath);
  return `${dir}${dir.endsWith(s) ? "" : s}${basenameNoExt(inputPath)}${ext}`;
}

function buildArgs(tab: MediaType, inputPath: string, outDir: string): string[] {
  const cmd = tab === "cd" ? "extractcd" : tab === "dvd" ? "extractdvd" : tab === "hd" ? "extracthd" : "extractraw";
  return [cmd, "-i", inputPath, "-o", outputPath(inputPath, OUTPUT_EXT[tab], outDir)];
}

export default function ExtractCHD() {
  const [tab, setTab]           = useState<MediaType>("cd");
  const [files, setFiles]       = useState<FileEntry[]>([]);
  const [inputDir, setInputDir] = useState<string | undefined>();
  const [outDir, setOutDir]     = useState("");

  useEffect(() => {
    invoke<{ input_dir: string; output_dir: string }>("get_app_dirs").then((dirs) => {
      setInputDir(dirs.input_dir);
      setOutDir(dirs.output_dir);
    }).catch(() => {});
  }, []);
  const [lines, setLines]         = useState<OutputLine[]>([]);
  const [running, setRunning]     = useState(false);
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  function handleTabChange(t: MediaType) {
    if (running) return;
    setTab(t); setFiles([]); setLines([]); setExitStatus(null);
  }

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function handleBrowseOutDir() {
    const result = await open({ directory: true, multiple: false });
    if (result && !Array.isArray(result)) setOutDir(result);
  }

  async function runOne(imagePath: string): Promise<boolean> {
    const args = buildArgs(tab, imagePath, outDir);
    setLines((prev) => [...prev, { stream: "info", line: `> chdman ${args.join(" ")}` }]);
    setProgressLabel("Extracting CHD…");
    setJobProgress(0);

    const unlistenOutput = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setLines((prev) => [
        ...prev,
        { stream: e.payload.stream as OutputLine["stream"], line: e.payload.line },
      ]);
    });

    const unlistenProgress = await listen<number>("chdman-progress", (e) => {
      setJobProgress(e.payload);
    });

    try {
      const code = await invoke<number>("run_chdman", { args });
      const ok = code === 0;
      setLines((prev) => [
        ...prev,
        { stream: ok ? "success" : "error", line: `Exit code ${code}` },
      ]);
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
    const settings = await invoke<{ chdman_path: string }>("get_settings").catch(() => ({ chdman_path: "" }));
    if (!settings.chdman_path.trim()) {
      setLines([{ stream: "error", line: "chdman path is not configured. Go to Settings to set it." }]);
      setExitStatus("error");
      return;
    }

    setRunning(true);
    setExitStatus(null);
    setLines([]);
    setProgress({ done: 0, total: files.length });
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" })));

    let allOk = true;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      updateFileStatus(file.id, "running");
      setLines((prev) => [
        ...prev,
        { stream: "info", line: `\n[${i + 1}/${files.length}] ${file.path}` },
      ]);

      let ok = true;

      if (isArchive(file.path)) {
        setLines((prev) => [...prev, { stream: "info", line: "→ Extracting archive…" }]);
        try {
          setProgressLabel("Decompressing…");
          setJobProgress(0);
          const unlistenExtract = await listen<number | null>("extract-progress", (e) => {
            setJobProgress(e.payload ?? null);
          });
          let extractResult: ArchiveContents;
          try {
            extractResult = await invoke<ArchiveContents>("extract_archive", { archivePath: file.path });
          } finally {
            unlistenExtract();
            setJobProgress(null);
          }
          const { temp_dir, files: chds } = extractResult;

          if (chds.length === 0) {
            setLines((prev) => [...prev, { stream: "error", line: "No CHD files found in archive." }]);
            ok = false;
          }

          for (let j = 0; j < chds.length; j++) {
            setLines((prev) => [
              ...prev,
              { stream: "info", line: `→ [${j + 1}/${chds.length}] ${basename(chds[j])}` },
            ]);
            if (!(await runOne(chds[j]))) ok = false;
          }

          await invoke("cleanup_dir", { dir: temp_dir }).catch(() => {});
        } catch (e) {
          setLines((prev) => [...prev, { stream: "error", line: `Extraction failed: ${String(e)}` }]);
          ok = false;
        }
      } else {
        ok = await runOne(file.path);
      }

      updateFileStatus(file.id, ok ? "success" : "error");
      if (!ok) allOk = false;
      setProgress({ done: i + 1, total: files.length });
    }

    setRunning(false);
    setExitStatus(allOk ? "success" : "error");
  }

  const handleCancel = () => invoke("cancel_chdman").catch(() => {});

  const outLabel =
    tab === "cd"  ? "Output folder (.cue + .bin per file)" :
    tab === "dvd" ? "Output folder (.iso per file)" :
    "Output folder (.raw per file)";

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">Extract CHD</h1>
        <p className="page-subtitle">Extract CHD files back to their original formats.</p>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => handleTabChange(t.id)}>
            {t.label}
          </div>
        ))}
      </div>

      <div className="form-grid">
        <BatchFileList
          files={files}
          onChange={setFiles}
          filters={CHD_FILTERS}
          folderExtensions={["chd"]}
          defaultDir={inputDir}
          disabled={running}
        />

        <div className="form-group">
          <label className="form-label">Output Folder</label>
          <div className="form-row">
            <input
              className="form-input"
              type="text"
              value={outDir}
              placeholder="Same as source (default)"
              onChange={(e) => setOutDir(e.currentTarget.value)}
              disabled={running}
              spellCheck={false}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleBrowseOutDir} disabled={running}>
              Browse…
            </button>
          </div>
        </div>

        {tab === "cd" && (
          <div className="alert alert-info">
            ℹ .bin is created automatically alongside the .cue sheet.
          </div>
        )}
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRunAll} disabled={files.length === 0}>
            ▶ Extract {files.length > 1 ? `All (${files.length})` : ""}
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>Cancel</button>
            <ProgressBar value={jobProgress} label={progressLabel} />
          </>
        )}
        {running && progress.total > 1 && (
          <span className="batch-progress">{progress.done} / {progress.total}</span>
        )}
        {!running && exitStatus === "success" && <div className="status-badge success">✓ All done</div>}
        {!running && exitStatus === "error"   && <div className="status-badge error">✗ Completed with errors</div>}
      </div>

      <OutputLog lines={lines} onClear={() => setLines([])} />
    </div>
  );
}
