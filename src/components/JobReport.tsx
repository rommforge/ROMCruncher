export interface ReportEntry {
  name: string;
  ok: boolean;
  datStatus: "match" | "no-match" | "skipped" | "error";
  gameName?: string;
  datFile?: string;
}

interface JobReportProps {
  entries: ReportEntry[];
  hasDats: boolean;
}

export default function JobReport({ entries, hasDats }: JobReportProps) {
  if (entries.length === 0) return null;

  const succeeded  = entries.filter((e) => e.ok).length;
  const failed     = entries.filter((e) => !e.ok).length;
  const matched    = entries.filter((e) => e.datStatus === "match").length;
  const unmatched  = entries.filter((e) => e.datStatus === "no-match").length;

  return (
    <div className="job-report">
      <div className="job-report-header">
        <span className="job-report-title">Job Report</span>
        <span className="job-report-summary">
          <span className={succeeded > 0 ? "report-count ok" : "report-count"}>
            {succeeded} succeeded
          </span>
          {failed > 0 && <span className="report-count fail">{failed} failed</span>}
          {hasDats && (
            <>
              <span className="report-sep">·</span>
              <span className={matched > 0 ? "report-count match" : "report-count"}>
                {matched} DAT matched
              </span>
              {unmatched > 0 && (
                <span className="report-count no-match">{unmatched} unmatched</span>
              )}
            </>
          )}
        </span>
      </div>

      <div className="job-report-table">
        <div className="job-report-thead">
          <span className="jrc jrc-status">Result</span>
          <span className="jrc jrc-name">File</span>
          {hasDats && <span className="jrc jrc-dat">DAT Match</span>}
        </div>
        {entries.map((e, i) => (
          <div key={i} className={`job-report-row ${e.ok ? "ok" : "fail"}`}>
            <span className="jrc jrc-status">
              {e.ok
                ? <span className="report-ok">✓</span>
                : <span className="report-fail">✗</span>}
            </span>
            <span className="jrc jrc-name" title={e.name}>{e.name}</span>
            {hasDats && (
              <span className="jrc jrc-dat">
                {e.datStatus === "match"
                  ? <span className="report-dat-match">✓ {e.gameName}<span className="report-dat-file"> [{e.datFile}]</span></span>
                  : e.datStatus === "no-match"
                  ? <span className="report-dat-none">– No match</span>
                  : e.datStatus === "error"
                  ? <span className="report-dat-err">Could not verify</span>
                  : <span className="report-dat-skip">—</span>}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
