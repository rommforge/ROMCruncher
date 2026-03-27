import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BatchFileList, { type FileEntry, ARCHIVE_EXTS } from "../components/BatchFileList";
import OutputLog, { type OutputLine } from "../components/OutputLog";
import ProgressBar from "../components/ProgressBar";
import { useDat } from "../context/DatContext";
import { buildReportLines, type ReportEntry } from "../components/JobReport";

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

function detectSourceType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "cue" || ext === "gdi") return "cd";
  if (ext === "avi") return "ld";
  if (ext === "iso") return "dvd";
  return null;
}

function buildArgs(mediaType: string, inputPath: string, outDir: string, opts: Record<string, string>): string[] {
  const cmdMap: Record<string, string> = { cd: "createcd", dvd: "createdvd", hd: "createhd", raw: "createraw", ld: "createld" };
  const cmd = cmdMap[mediaType] ?? "createcd";
  const out = outputPath(inputPath, ".chd", outDir);
  const args = [cmd, "-i", inputPath, "-o", out];
  if (opts.compression) args.push("-c", opts.compression);
  const hunksize = opts.hunksize || (mediaType === "dvd" ? "2048" : "");
  if (hunksize) args.push("-hs", hunksize);
  if (opts.processors)  args.push("-np", opts.processors);
  if (mediaType === "hd"  && opts.sectorsize) args.push("-ss", opts.sectorsize);
  if (mediaType === "raw" && opts.sectorsize) args.push("-us", opts.sectorsize);
  if (opts.force === "1") args.push("-f");
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

  const [mediaTypeOverride, setMediaTypeOverride] = useState("auto");

  const [lines, setLines]         = useState<OutputLine[]>([]);
  const [running, setRunning]     = useState(false);
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [exitStatus, setExitStatus] = useState<"success" | "error" | null>(null);

  const { datIndex } = useDat();
  const cancelledRef = useRef(false);
  const [deleteOnVerify, setDeleteOnVerify] = useState(false);
  const setOpt = (k: string, v: string) => setOpts((p) => ({ ...p, [k]: v }));

  async function runVerify(outputPath: string): Promise<boolean> {
    setProgressLabel("Verifying…");
    setJobProgress(null);
    setLines((prev) => [...prev, { stream: "info", line: "→ Verifying CHD integrity…" }]);
    const args = ["verify", "-i", outputPath];
    const unlistenOutput = await listen<{ stream: string; line: string }>("chdman-output", (e) => {
      setLines((prev) => [...prev, { stream: e.payload.stream as OutputLine["stream"], line: e.payload.line }]);
    });
    try {
      const code = await invoke<number>("run_chdman", { args });
      return code === 0;
    } catch {
      return false;
    } finally {
      unlistenOutput();
      setJobProgress(null);
    }
  }

  function updateFileStatus(id: string, status: FileEntry["status"]) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
  }

  async function checkDat(filePath: string): Promise<Pick<ReportEntry, "datStatus" | "gameName" | "datFile">> {
    if (datIndex.size === 0) return { datStatus: "skipped" };
    try {
      setProgressLabel("Verifying…");
      setJobProgress(null);
      const sha1s = await invoke<string[]>("get_chd_data_sha1", { path: filePath });
      const match = sha1s.reduce<ReturnType<typeof datIndex.get>>((m, s) => m ?? datIndex.get(s), undefined);
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

  async function handleBrowseOutDir() {
    const result = await open({ directory: true, multiple: false, defaultPath: outDir || undefined });
    if (result && !Array.isArray(result)) setOutDir(result);
  }

  async function runOne(imagePath: string): Promise<{ ok: boolean; outputPath: string }> {
    const out = outputPath(imagePath, ".chd", outDir);
    const mediaType = mediaTypeOverride !== "auto" ? mediaTypeOverride : detectSourceType(imagePath);
    if (!mediaType) {
      setLines((prev) => [...prev, { stream: "error", line: `→ Cannot auto-detect media type for this file type. Set the Media Type Override before running.` }]);
      return { ok: false, outputPath: out };
    }
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
      return { ok, outputPath: out };
    } catch (e) {
      setLines((prev) => [...prev, { stream: "error", line: String(e) }]);
      return { ok: false, outputPath: out };
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
    const reportEntries: ReportEntry[] = [];
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
            const result = await runOne(images[j]);
            const dat = result.ok ? await checkDat(result.outputPath) : { datStatus: "skipped" as const };
            if (!result.ok) ok = false;
            reportEntries.push({ name: basename(images[j]), ok: result.ok, ...dat });
          }

          await invoke("cleanup_dir", { dir: temp_dir }).catch(() => {});
        } catch (e) {
          setLines((prev) => [...prev, { stream: "error", line: `Extraction failed: ${String(e)}` }]);
          ok = false;
        }
      } else {
        const result = await runOne(file.path);
        ok = result.ok;
        const dat = ok ? await checkDat(result.outputPath) : { datStatus: "skipped" as const };
        reportEntries.push({ name: basename(file.path), ok, ...dat });

        if (ok && deleteOnVerify) {
          const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
          if (ext === "cue" || ext === "gdi") {
            setLines((prev) => [...prev, { stream: "info", line: "→ Delete skipped: multi-file source (.cue/.gdi) — remove companion files manually" }]);
          } else {
            const verified = await runVerify(result.outputPath);
            if (verified) {
              try {
                await invoke("delete_file", { path: file.path });
                setLines((prev) => [...prev, { stream: "info", line: `→ Source deleted: ${basename(file.path)}` }]);
              } catch (e) {
                setLines((prev) => [...prev, { stream: "error", line: `→ Delete failed: ${String(e)}` }]);
              }
            } else {
              setLines((prev) => [...prev, { stream: "error", line: "→ Verify failed — source kept" }]);
            }
          }
        }
      }

      updateFileStatus(file.id, ok ? "success" : "error");
      if (!ok) allOk = false;
      setProgress({ done: i + 1, total: files.length });
    }

    if (reportEntries.length > 1) {
      setLines((prev) => [...prev, ...buildReportLines(reportEntries, datIndex.size > 0)]);
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
            <label className="form-label">Media Type Override</label>
            <select
              className="form-input"
              value={mediaTypeOverride}
              onChange={(e) => setMediaTypeOverride(e.currentTarget.value)}
              disabled={running}
            >
              <option value="auto">Auto-Detect</option>
              <option value="cd">CD-ROM</option>
              <option value="dvd">DVD-ROM</option>
              <option value="hd">Hard Disk</option>
              <option value="raw">Raw</option>
              <option value="ld">LaserDisc</option>
            </select>
          </div>

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
            <label className="form-label">Sector/Unit Size (bytes, HD/Raw only)</label>
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

          <div className="form-group form-group-check">
            <label className="form-check">
              <input
                type="checkbox"
                checked={opts.force === "1"}
                onChange={(e) => setOpt("force", e.currentTarget.checked ? "1" : "")}
                disabled={running}
              />
              Overwrite existing files
            </label>
          </div>

          <div className="form-group form-group-check">
            <label className="form-check">
              <input
                type="checkbox"
                checked={deleteOnVerify}
                onChange={(e) => setDeleteOnVerify(e.currentTarget.checked)}
                disabled={running}
              />
              Delete source after successful verify
            </label>
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
