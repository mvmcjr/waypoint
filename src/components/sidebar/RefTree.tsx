import { useState } from "react";
import type { RefInfo } from "@/lib/ipc";

interface GroupProps {
  label: string;
  refs: RefInfo[];
  onSelect?: (ref: RefInfo) => void;
}

function RefGroup({ label, refs, onSelect }: GroupProps) {
  const [open, setOpen] = useState(true);

  if (refs.length === 0) return null;

  return (
    <div className="mb-1">
      <button
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground uppercase tracking-wider hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        <span className="ml-auto text-[10px] opacity-60">{refs.length}</span>
      </button>

      {open && (
        <ul>
          {refs.map((ref) => (
            <li key={ref.name}>
              <button
                className={`w-full text-left px-4 py-0.5 text-sm truncate hover:bg-white/5 rounded
                  ${ref.is_head ? "text-green-400 font-semibold" : "text-foreground/80"}`}
                onClick={() => onSelect?.(ref)}
              >
                {ref.is_head && <span className="mr-1">●</span>}
                {ref.shorthand}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Props {
  refs: RefInfo[];
  onSelectRef?: (ref: RefInfo) => void;
}

export function RefTree({ refs, onSelectRef }: Props) {
  const local = refs.filter((r) => r.kind === "local_branch");
  const remote = refs.filter((r) => r.kind === "remote_branch");
  const tags = refs.filter((r) => r.kind === "tag");

  return (
    <div className="overflow-auto flex-1">
      <RefGroup label="Branches" refs={local} onSelect={onSelectRef} />
      <RefGroup label="Remotes" refs={remote} onSelect={onSelectRef} />
      <RefGroup label="Tags" refs={tags} onSelect={onSelectRef} />
    </div>
  );
}
