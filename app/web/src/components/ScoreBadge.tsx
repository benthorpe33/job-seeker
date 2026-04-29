type Props = { score: number | null };

function band(score: number): string {
  if (score >= 4.5) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (score >= 4.0) return "bg-lime-500/20 text-lime-300 border-lime-500/40";
  if (score >= 3.5) return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return "bg-slate-600/30 text-slate-400 border-slate-600/40";
}

export function ScoreBadge({ score }: Props) {
  if (score === null) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center justify-center rounded border px-2 py-0.5 text-xs font-mono tabular-nums ${band(score)}`}
    >
      {score.toFixed(1)}
    </span>
  );
}
