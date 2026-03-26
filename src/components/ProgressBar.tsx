interface ProgressBarProps {
  /** 0-100 for determinate, null for indeterminate animation */
  value: number | null;
  label?: string;
}

export default function ProgressBar({ value, label }: ProgressBarProps) {
  return (
    <div className="progress-wrap">
      {label && <span className="progress-label">{label}</span>}
      <div className="progress-track">
        <div
          className={`progress-fill${value === null ? " indeterminate" : ""}`}
          style={value !== null ? { width: `${value}%` } : undefined}
        />
      </div>
      {value !== null && (
        <span className="progress-pct">{value}%</span>
      )}
    </div>
  );
}
