import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BatchFileList, { type FileEntry } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";
import { useDat } from "../context/DatContext";
import JobReport, { type ReportEntry } from "../components/JobReport";

const CHD_FILTERS = [{ name: "CHD Files", extensions: ["chd"] }];

const EXTRACT_CMD: Record<string, string> = { cd: "extractcd", dvd: "extractdvd", hd: "extracthd", raw: "extractraw", ld: "extractld" };
const CREATE_CMD:  Record<string, string> = { cd: "createcd",  dvd: "createdvd",  hd: "createhd",  raw: "createraw",  ld: "createld"  };
const INTERMEDIATE_EXT: Record<string, string> = { cd: ".cue", dvd: ".iso", hd: ".raw", raw: ".raw", ld: ".avi" };

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

function outputChdPath(inputPath: string, outDir: string): string {
  const dir = outDir || dirOf(inputPath);
  const s = sep(dir || inputPath);
  return `${dir}${dir.endsWith(s) ? "" : s}${basenameNoExt(inputPath)}.chd`;
}

export default function ConvertCHD() {
  const [files, setFiles]       = useState<FileEntry[]>([]);
  const [inputDir, setInputDir] = useState<string | undefined>();
  const [outDir, setOutDir]     = useState("");
  const [opts, setOpts]         = useState<Record<string, string>>({});
  const [maxThreads, setMaxThreads] = useState<number>(0);

  const [lines, setLines]         = useState<OutputLine[]>([]);
  const [running, setRunning]     = useState(false);
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    invoke<{ input_dir: string; output_dir: string }>("get_app_dirs").then((dirs) => {
      setInputDir(dirs.input_dir);
      setOutDir(dirs.output_dir);
    }).catch(() => {});
    invoke<number>("get_cpu_threads").then(setMaxThreads).catch(() => {});
  }, []);

  const { datIndex } = useDat();
  const cancelledRef = useRef(false);
  const [force, setForce] = useState(false);
  const [report, setReport] = useState<ReportEntry[]>([]);
  const setOpt = (k: string, v: string) => setOpts((p) => ({ ...p, [k]: v }));

  async function checkDat(filePath: string): Promise<Pick<ReportEntry, "datStatus" | "gameName" | "datFile">> {
    if (datIndex.size === 0) return { datStatus: "skipped" };
    try {
      setProgressLabel("Verifying…");
      setJobProgress(null);
      const sha1 = await invoke<string>("get_chd_data_sha1", { path: filePath });
      const match = datIndex.get(sha1);
      if (match) {
        setLines((prev) => [...prev, { stream: "success", line: `→ DAT: ✓ ${match.gameName} [${match.datFile}]` }]);
        return { datStatus: "match", gameName: match.gameName, datFile: match.datFile };
      }
      setLines((prev) => [...prev, { stream: "info", line: "→ DAT: No match found" }]);
      return { datStatus: "no-match" };
    } catch {
      setLines((prev) => [...prev, { stream: "info", line: "→ DAT: Could not verify" }]);
      return { datStatus: "error" };
    }
  }

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function handleBrowseOutDir() {
    const result = await open({ directory: true, multiple: false, defaultPath: outDir || undefined });
    if (result && !Array.isArray(result)) setOutDir(result);
  }

  async function runChdman(args: string[], label: string): Promise<boolean> {
    setProgressLabel(label);
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

  async function convertOne(inputPath: string): Promise<{ ok: boolean; outputPath: string }> {
    let mediaType = "cd";
    try {
      mediaType = await invoke<string>("detect_chd_type", { path: inputPath });
    } catch {
      setLines((prev) => [...prev, { stream: "info", line: "→ Could not detect type, defaulting to CD-ROM" }]);
    }

    const intExt = INTERMEDIATE_EXT[mediaType] ?? ".cue";
    const tempDir = await invoke<string>("create_temp_dir");
    const s = sep(inputPath);
    const intermediatePath = `${tempDir}${s}${basenameNoExt(inputPath)}${intExt}`;
    const out = outputChdPath(inputPath, outDir);

    try {
      setLines((prev) => [...prev, { stream: "info", line: `→ Step 1/2: Extracting to ${intExt}…` }]);
      const extractArgs = [EXTRACT_CMD[mediaType] ?? "extractcd", "-i", inputPath, "-o", intermediatePath];
      setLines((prev) => [...prev, { stream: "info", line: `> chdman ${extractArgs.join(" ")}` }]);
      if (!(await runChdman(extractArgs, "Extracting… (1/2)"))) return { ok: false, outputPath: out };

      setLines((prev) => [...prev, { stream: "info", line: `→ Step 2/2: Re-encoding to CHD…` }]);
      const createArgs = [CREATE_CMD[mediaType] ?? "createcd", "-i", intermediatePath, "-o", out];
      if (opts.compression) createArgs.push("-c", opts.compression);
      if (opts.hunksize)    createArgs.push("-hs", opts.hunksize);
      if (opts.processors)  createArgs.push("-np", opts.processors);
      if (force)            createArgs.push("-f");
      setLines((prev) => [...prev, { stream: "info", line: `> chdman ${createArgs.join(" ")}` }]);
      const ok = await runChdman(createArgs, "Re-encoding… (2/2)");
      return { ok, outputPath: out };
    } finally {
      await invoke("cleanup_dir", { dir: tempDir }).catch(() => {});
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
    setReport([]);
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

      const result = await convertOne(file.path);
      const ok = result.ok;
      const dat = ok ? await checkDat(result.outputPath) : { datStatus: "skipped" as const };
      setReport((prev) => [...prev, { name: basename(file.path), ok, ...dat }]);
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
        <h1 className="page-title">Convert CHD</h1>
        <p className="page-subtitle">Re-encode CHDs using the current chdman version to ensure hash compatibility.</p>
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
              placeholder="Output folder"
              onChange={(e) => setOutDir(e.currentTarget.value)}
              disabled={running}
              spellCheck={false}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleBrowseOutDir} disabled={running}>
              Browse…
            </button>
          </div>
        </div>

        <div className="form-section-title">Re-encode Options</div>

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

          <div className="form-group form-group-check">
            <label className="form-check">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.currentTarget.checked)}
                disabled={running}
              />
              Overwrite existing files
            </label>
          </div>
        </div>
      </div>

      <div className="actions-row">
        {!running ? (
          <button className="btn btn-primary" onClick={handleRunAll} disabled={files.length === 0}>
            ▶ Convert {files.length > 1 ? `All (${files.length})` : ""}
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
      {!running && <JobReport entries={report} hasDats={datIndex.size > 0} />}
    </div>
  );
}
