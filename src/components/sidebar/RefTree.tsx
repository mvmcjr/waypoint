import { useState, useEffect } from "react";
import { GitBranch, Globe, Tag, ChevronRight } from "lucide-react";
import type { RefInfo } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const GROUP_META = {
  Branches: { icon: GitBranch },
  Remotes:  { icon: Globe },
  Tags:     { icon: Tag },
} as const;

interface GroupProps {
  label: keyof typeof GROUP_META;
  refs: RefInfo[];
  filter?: string;
  onSelect?: (ref: RefInfo) => void;
  onCheckout?: (ref: RefInfo) => void;
  showContextMenu?: boolean;
}

function RefGroup({ label, refs, filter, onSelect, onCheckout, showContextMenu }: GroupProps) {
  const [open, setOpen] = useState(true);
  const { icon: Icon } = GROUP_META[label];

  useEffect(() => {
    if (filter) setOpen(true);
  }, [filter]);

  const visible = filter
    ? refs.filter((r) => r.shorthand.toLowerCase().includes(filter.toLowerCase()))
    : refs;

  if (visible.length === 0) return null;

  return (
    <div>
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/55 uppercase tracking-[0.12em] hover:text-muted-foreground/80 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={10} className="opacity-70 shrink-0" />
        <span>{label}</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[9px] opacity-40 tabular-nums">{visible.length}</span>
          <ChevronRight
            size={10}
            className={`opacity-35 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>

      {open && (
        <ul className="pb-0.5">
          {visible.map((ref) => {
            const btn = (
              <button
                className={[
                  "w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center gap-2 transition-colors duration-75",
                  ref.is_head
                    ? "text-teal-300/90 font-medium hover:bg-teal-500/8"
                    : "text-foreground/55 hover:text-foreground/80 hover:bg-white/[0.05]",
                ].join(" ")}
                onClick={() => onSelect?.(ref)}
              >
                <span className={[
                  "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
                  ref.is_head ? "bg-teal-400 shadow-[0_0_4px_rgba(45,212,191,0.5)]" : "bg-transparent",
                ].join(" ")} />
                <span className="truncate">{ref.shorthand}</span>
              </button>
            );

            if (!showContextMenu || !onCheckout) {
              return <li key={ref.name}>{btn}</li>;
            }

            return (
              <li key={ref.name}>
                <ContextMenu>
                  <ContextMenuTrigger>{btn}</ContextMenuTrigger>
                  <ContextMenuContent>
                    {!ref.is_head && (
                      <ContextMenuItem onClick={() => onCheckout(ref)}>
                        Checkout {ref.shorthand}
                      </ContextMenuItem>
                    )}
                    {ref.is_head && (
                      <ContextMenuItem disabled className="text-muted-foreground">
                        Current branch
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface Props {
  refs: RefInfo[];
  filter?: string;
  onSelectRef?: (ref: RefInfo) => void;
  onCheckoutBranch?: (branchName: string) => void;
}

export function RefTree({ refs, filter, onSelectRef, onCheckoutBranch }: Props) {
  const local  = refs.filter((r) => r.kind === "local_branch");
  const remote = refs.filter((r) => r.kind === "remote_branch");
  const tags   = refs.filter((r) => r.kind === "tag");

  return (
    <div className="overflow-auto flex-1 py-1">
      <RefGroup
        label="Branches"
        refs={local}
        filter={filter}
        onSelect={onSelectRef}
        onCheckout={onCheckoutBranch ? (ref) => onCheckoutBranch(ref.shorthand) : undefined}
        showContextMenu
      />
      <RefGroup label="Remotes" refs={remote} filter={filter} onSelect={onSelectRef} />
      <RefGroup label="Tags"    refs={tags}   filter={filter} onSelect={onSelectRef} />
    </div>
  );
}
