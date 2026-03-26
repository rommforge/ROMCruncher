import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BatchFileList, { type FileEntry, ARCHIVE_EXTS } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";

const ALL_FILTERS = [{ name: "Disc/Disk Images", extensions: ["cue", "gdi", "iso", "raw", "img", "bin", "avi"] }];
const ALL_FOLDER_EXTS = ["cue", "gdi", "iso", "raw", "img", "bin", "avi"];

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

async function detectSourceType(path: string): Promise<string> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "cue" || ext === "gdi") return "cd";
  if (ext === "avi") return "ld";
  if (ext === "img" || ext === "bin") return "hd";
  if (ext === "raw") return "raw";
  if (ext === "iso") {
    try {
      const size = await invoke<number>("get_file_size", { path });
      return size > 1_000_000_000 ? "dvd" : "cd";
    } catch {
      return "cd";
    }
  }
  return "cd";
}

function buildArgs(mediaType: string, inputPath: string, outDir: string, opts: Record<string, string>): string[] {
  const cmdMap: Record<string, string> = { cd: "createcd", dvd: "createdvd", hd: "createhd", raw: "createraw", ld: "createld" };
  const cmd = cmdMap[mediaType] ?? "createcd";
  const out = outputPath(inputPath, ".chd", outDir);
  const args = [cmd, "-i", inputPath, "-o", out];
  if (opts.compression) args.push("-c", opts.compression);
  if (opts.hunksize)    args.push("-hs", opts.hunksize);
  if (opts.processors)  args.push("-np", opts.processors);
  if ((mediaType === "hd" || mediaType === "raw") && opts.sectorsize) args.push("-ss", opts.sectorsize);
  return args;
}

export default function CreateCHD() {
  const [files, setFiles]       = useState<FileEntry[]>([]);
  const [inputDir, setInputDir] = useState<string | undefined>();
  const [outDir, setOutDir]     = useState("");
  const [opts, setOpts]         = useState<Record<string, string>>({});
  const [maxThreads, setMaxThreads] = useState<number>(0);

  useEffect(() => {
    invoke<{ input_dir: string; output_dir: string }>("get_app_dirs").then((dirs) => {
      setInputDir(dirs.input_dir);
      setOutDir(dirs.output_dir);
    }).catch(() => {});
    invoke<number>("get_cpu_threads").then(setMaxThreads).catch(() => {});
  }, []);

  const [lines, setLines]         = useState<OutputLine[]>([]);
  const [running, setRunning]     = useState(false);
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  const cancelledRef = useRef(false);
  const setOpt = (k: string, v: string) => setOpts((p) => ({ ...p, [k]: v }));

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function handleBrowseOutDir() {
    const result = await open({ directory: true, multiple: false, defaultPath: outDir || undefined });
    if (result && !Array.isArray(result)) setOutDir(result);
  }

  async function runOne(imagePath: string): Promise<boolean> {
    const mediaType = await detectSourceType(imagePath);
    const args = buildArgs(mediaType, imagePath, outDir, opts);
    setLines((prev) => [...prev, { stream: "info", line: `> chdman ${args.join(" ")}` }]);
    setProgressLabel("Converting…");
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
      setLines((prev) => [
        ...prev,
        { stream: "info", line: `\n[${i + 1}/${files.length}] ${file.path}` },
      ]);

      let ok = true;

      if (isArchive(file.path)) {
        setLines((prev) => [...prev, { stream: "info", line: "→ Extracting archive…" }]);
        try {
          setProgressLabel("Extracting…");
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
          const { temp_dir, files: images } = extractResult;

          if (images.length === 0) {
            setLines((prev) => [...prev, { stream: "error", line: "No disc images found in archive." }]);
            ok = false;
          }

          for (let j = 0; j < images.length; j++) {
            setLines((prev) => [
              ...prev,
              { stream: "info", line: `→ [${j + 1}/${images.length}] ${basename(images[j])}` },
            ]);
            if (!(await runOne(images[j]))) ok = false;
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

  const handleCancel = () => { cancelledRef.current = true; invoke("cancel_chdman").catch(() => {}); };

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1 className="page-title">Create CHD</h1>
        <p className="page-subtitle">Convert disc or disk images into CHD format.</p>
      </div>

      <div className="form-grid">
        <BatchFileList
          files={files}
          onChange={setFiles}
          filters={ALL_FILTERS}
          folderExtensions={ALL_FOLDER_EXTS}
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

        <div className="form-section-title">Options</div>

        <div className="options-grid">
          <div className="form-group">
            <label className="form-label">Compression</label>
            <input
              className="form-input"
              type="text"
              value={opts.compression ?? ""}
              placeholder="e.g. zlib,lzma (blank = default)"
              onChange={(e) => setOpt("compression", e.currentTarget.value)}
              disabled={running}
            />
          </div>

          <div className="form-group">
            <label className="form-label">CPU Threads{maxThreads > 0 ? ` (max ${maxThreads})` : ""}</label>
            <input
              className="form-input"
              type="number"
              value={opts.processors ?? ""}
              placeholder="All (default)"
              min={1}
              max={maxThreads > 0 ? maxThreads : undefined}
              onChange={(e) => setOpt("processors", e.currentTarget.value)}
              disabled={running}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Hunk Size (bytes)</label>
            <input
              className="form-input"
              type="number"
              value={opts.hunksize ?? ""}
              placeholder="Default"
              min={16}
              onChange={(e) => setOpt("hunksize", e.currentTarget.value)}
              disabled={running}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Sector Size (bytes, HD/Raw only)</label>
            <input
              className="form-input"
              type="number"
              value={opts.sectorsize ?? ""}
              placeholder="512 (default)"
              min={16}
              onChange={(e) => setOpt("sectorsize", e.currentTarget.value)}
              disabled={running}
            />
          </div>
        </div>
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRunAll} disabled={files.length === 0}>
            ▶ Create {files.length > 1 ? `All (${files.length})` : ""}
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
