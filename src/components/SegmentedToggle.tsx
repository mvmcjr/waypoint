import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface Props<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Accessible name for the group, e.g. "File list view". */
  label: string;
}

/**
 * Small single-choice pill (Path / Tree, Unified / Split, …) used in panel
 * toolbars. A white-alpha well with the pressed item lifted one overlay step.
 */
export function SegmentedToggle<T extends string>({ value, options, onChange, label }: Props<T>) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      // Clicking the already-pressed item would empty the group — a single-choice
      // control always has exactly one value, so ignore that.
      onValueChange={(next) => { if (next[0]) onChange(next[0] as T); }}
      spacing={0.5}
      className="rounded-md bg-white/[0.04] p-0.5"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="h-5 min-w-0 rounded-[5px] px-1.5 text-[10px] font-normal text-muted-foreground hover:bg-white/[0.04] hover:text-foreground aria-pressed:bg-white/[0.07] aria-pressed:text-foreground focus-visible:ring-2"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
