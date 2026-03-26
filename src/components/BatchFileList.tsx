import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface FileEntry {
  id: string;
  path: string;
  status: "pending" | "running" | "success" | "error";
}

interface Filter {
  name: string;
  extensions: string[];
}

interface BatchFileListProps {
  files: FileEntry[];
  onChange: (files: FileEntry[]) => void;
  filters: Filter[];
  folderExtensions: string[];
  defaultDir?: string;
  disabled?: boolean;
}

export const ARCHIVE_EXTS = ["zip", "7z", "rar"];

function makeEntry(path: string): FileEntry {
  return { id: `${Date.now()}-${Math.random()}`, path, status: "pending" };
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? path.substring(0, idx) : "";
}

function mergeFiles(existing: FileEntry[], newPaths: string[]): FileEntry[] {
  const seen = new Set(existing.map((f) => f.path));
  return [...existing, ...newPaths.filter((p) => !seen.has(p)).map(makeEntry)];
}

const STATUS_ICON: Record<FileEntry["status"], string> = {
  pending: "○",
  running: "◉",
  success: "✓",
  error:   "✗",
};

export default function BatchFileList({
  files,
  onChange,
  filters,
  folderExtensions,
  defaultDir,
  disabled,
}: BatchFileListProps) {
  async function handleAddFiles() {
    const allExts = [...filters.flatMap((f) => f.extensions), ...ARCHIVE_EXTS];
    const allFilters = [
      { name: "All Supported Files", extensions: allExts },
      ...filters,
      { name: "Archives", extensions: ARCHIVE_EXTS },
    ];
    const result = await open({ filters: allFilters, multiple: true, defaultPath: defaultDir });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    onChange(mergeFiles(files, paths));
  }

  async function handleAddFolder() {
    const result = await open({ directory: true, multiple: false, defaultPath: defaultDir });
    if (!result || Array.isArray(result)) return;
    const allExts = [...folderExtensions, ...ARCHIVE_EXTS];
    const found = await invoke<string[]>("scan_folder", {
      dir: result,
      extensions: allExts,
    });
    onChange(mergeFiles(files, found));
  }

  function handleRemove(id: string) {
    onChange(files.filter((f) => f.id !== id));
  }

  function handleClearAll() {
    onChange([]);
  }

  return (
    <div className="form-group">
      <label className="form-label required">Input Files</label>
      <div className="file-list-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleAddFiles}
          disabled={disabled}
        >
          + Add Files
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleAddFolder}
          disabled={disabled}
        >
          + Add Folder
        </button>
        {files.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleClearAll}
            disabled={disabled}
          >
            Clear All
          </button>
        )}
      </div>

      <div className="file-list">
        {files.length === 0 ? (
          <div className="file-list-empty">
            No files selected — add individual files (.zip / .7z / .rar included) or a folder.
          </div>
        ) : (
          files.map((f) => (
            <div key={f.id} className="file-list-item">
              <span className={`file-status-icon ${f.status}`}>
                {STATUS_ICON[f.status]}
              </span>
              <span className="file-path" title={f.path}>
                {basename(f.path)}
              </span>
              <button
                className="file-remove-btn"
                onClick={() => handleRemove(f.id)}
                disabled={disabled || f.status === "running"}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
