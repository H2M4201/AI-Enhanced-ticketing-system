/** A small spinner with the name of the step that is running, so a long request says what it is doing. */
export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-neutral-700">
      <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      {label}
    </span>
  );
}
