type Props = { status: string };

function tone(status: string): string {
  switch (status) {
    case "Applied":
      return "bg-blue-500/20 text-blue-300 border-blue-500/40";
    case "Interview":
      return "bg-violet-500/20 text-violet-300 border-violet-500/40";
    case "Offer":
      return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
    case "Responded":
      return "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";
    case "Rejected":
      return "bg-rose-500/20 text-rose-300 border-rose-500/40";
    case "Discarded":
      return "bg-zinc-500/20 text-zinc-400 border-zinc-500/40";
    case "SKIP":
      return "bg-slate-500/20 text-slate-400 border-slate-500/40";
    case "Evaluated":
    default:
      return "bg-slate-700/40 text-slate-300 border-slate-600/40";
  }
}

export function StatusChip({ status }: Props) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs ${tone(status)}`}
    >
      {status || "—"}
    </span>
  );
}
