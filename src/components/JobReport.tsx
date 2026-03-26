import type { OutputLine } from "./OutputLog";

export interface ReportEntry {
  name: string;
  ok: boolean;
  datStatus: "match" | "no-match" | "skipped" | "error";
  gameName?: string;
  datFile?: string;
}

export function buildReportLines(entries: ReportEntry[], hasDats: boolean): OutputLine[] {
  if (entries.length === 0) return [];

  const succeeded = entries.filter((e) => e.ok).length;
  const failed    = entries.filter((e) => !e.ok).length;
  const matched   = entries.filter((e) => e.datStatus === "match").length;
  const unmatched = entries.filter((e) => e.datStatus === "no-match").length;

  const lines: OutputLine[] = [];
  lines.push({ stream: "info", line: "\n── Job Report " + "─".repeat(46) });

  for (const e of entries) {
    let text = `  ${e.ok ? "✓" : "✗"}  ${e.name}`;
    if (hasDats) {
      if (e.datStatus === "match")    text += `  ·  ✓ ${e.gameName} [${e.datFile}]`;
      else if (e.datStatus === "no-match") text += "  ·  – No DAT match";
      else if (e.datStatus === "error")    text += "  ·  DAT check failed";
    }
    lines.push({ stream: e.ok ? "success" : "error", line: text });
  }

  lines.push({ stream: "info", line: "─".repeat(60) });

  let summary = `  ${succeeded} succeeded`;
  if (failed > 0)    summary += ` · ${failed} failed`;
  if (hasDats) {
    summary += ` · ${matched} DAT matched`;
    if (unmatched > 0) summary += ` · ${unmatched} unmatched`;
  }
  lines.push({ stream: failed > 0 ? "error" : "success", line: summary });

  return lines;
}
