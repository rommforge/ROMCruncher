import { useEffect, useRef } from "react";

export interface OutputLine {
  stream: "stdout" | "stderr" | "info" | "success" | "error";
  line: string;
}

interface OutputLogProps {
  lines: OutputLine[];
  onClear: () => void;
}

export default function OutputLog({ lines, onClear }: OutputLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="output-section">
      <div className="output-header">
        <span className="output-title">Output</span>
        {lines.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <div className="output-log">
        {lines.length === 0 ? (
          <span className="output-empty">Output will appear here…</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`output-line ${l.stream}`}>
              {l.line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
