export function SafetyBanner() {
  return (
    <div
      role="alert"
      className="sticky top-0 z-30 border-b border-rose-500/60 bg-rose-700/95 px-4 py-2 text-center text-sm font-medium text-rose-50 shadow"
    >
      These answers are NEVER auto-submitted. Copy each one manually into the
      application form.
    </div>
  );
}
