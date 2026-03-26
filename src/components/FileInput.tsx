import { open, save } from "@tauri-apps/plugin-dialog";

interface Filter {
  name: string;
  extensions: string[];
}

interface FileInputProps {
  label: string;
  value: string;
  onChange: (path: string) => void;
  mode: "open" | "save";
  filters?: Filter[];
  defaultPath?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  onMultiple?: (paths: string[]) => void;
}

export default function FileInput({
  label,
  value,
  onChange,
  mode,
  filters,
  defaultPath,
  placeholder,
  required,
  multiple,
  onMultiple,
}: FileInputProps) {
  async function browse() {
    if (mode === "open") {
      const result = await open({ filters, multiple: multiple ?? false });
      if (result === null) return;
      if (Array.isArray(result)) {
        if (onMultiple) onMultiple(result);
        else if (result.length > 0) onChange(result[0]);
      } else {
        onChange(result);
      }
    } else {
      const result = await save({ filters, defaultPath });
      if (result !== null) onChange(result);
    }
  }

  return (
    <div className="form-group">
      <label className={`form-label${required ? " required" : ""}`}>{label}</label>
      <div className="form-row">
        <input
          className="form-input"
          type="text"
          value={value}
          placeholder={placeholder ?? "No file selected"}
          onChange={(e) => onChange(e.currentTarget.value)}
          spellCheck={false}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={browse}>
          Browse…
        </button>
      </div>
    </div>
  );
}
