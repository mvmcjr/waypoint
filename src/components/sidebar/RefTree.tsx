import { useState } from "react";
import type { RefInfo } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface GroupProps {
  label: string;
  refs: RefInfo[];
  onSelect?: (ref: RefInfo) => void;
  onCheckout?: (ref: RefInfo) => void;
  showContextMenu?: boolean;
}

function RefGroup({ label, refs, onSelect, onCheckout, showContextMenu }: GroupProps) {
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
          {refs.map((ref) => {
            const btn = (
              <button
                className={`w-full text-left px-4 py-0.5 text-sm truncate hover:bg-white/5 rounded
                  ${ref.is_head ? "text-green-400 font-semibold" : "text-foreground/80"}`}
                onClick={() => onSelect?.(ref)}
              >
                {ref.is_head && <span className="mr-1">●</span>}
                {ref.shorthand}
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
  onSelectRef?: (ref: RefInfo) => void;
  onCheckoutBranch?: (branchName: string) => void;
}

export function RefTree({ refs, onSelectRef, onCheckoutBranch }: Props) {
  const local = refs.filter((r) => r.kind === "local_branch");
  const remote = refs.filter((r) => r.kind === "remote_branch");
  const tags = refs.filter((r) => r.kind === "tag");

  return (
    <div className="overflow-auto flex-1">
      <RefGroup
        label="Branches"
        refs={local}
        onSelect={onSelectRef}
        onCheckout={onCheckoutBranch ? (ref) => onCheckoutBranch(ref.shorthand) : undefined}
        showContextMenu
      />
      <RefGroup label="Remotes" refs={remote} onSelect={onSelectRef} />
      <RefGroup label="Tags" refs={tags} onSelect={onSelectRef} />
    </div>
  );
}
