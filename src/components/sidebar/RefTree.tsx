import { useState, useEffect } from "react";
import { GitBranch, Globe, Tag, ChevronRight } from "lucide-react";
import type { RefInfo } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type RefAction =
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "checkout-tag"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "rebase"; oid: string }
  | { kind: "push"; branchName: string }
  | { kind: "delete-branch"; branchName: string }
  | { kind: "push-tag"; tagName: string }
  | { kind: "delete-tag"; tagName: string };

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
  onRefAction?: (action: RefAction) => void;
}

function RefGroup({ label, refs, filter, onSelect, onRefAction }: GroupProps) {
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
                  "w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center justify-between gap-2 transition-colors duration-75",
                  ref.is_head
                    ? "text-teal-300/90 font-medium hover:bg-teal-500/8"
                    : "text-foreground/55 hover:text-foreground/80 hover:bg-white/[0.05]",
                ].join(" ")}
                onClick={() => onSelect?.(ref)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={[
                    "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
                    ref.is_head ? "bg-teal-400 shadow-[0_0_4px_rgba(45,212,191,0.5)]" : "bg-transparent",
                  ].join(" ")} />
                  <span className="truncate">{ref.shorthand}</span>
                </div>
                {label === "Tags" && !ref.is_pushed && (
                  <span className="text-[9px] font-semibold text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 shrink-0 select-none tracking-wide uppercase">
                    local
                  </span>
                )}
              </button>
            );

            const menuContent = buildMenu(label, ref, onRefAction);

            if (!menuContent) {
              return <li key={ref.name}>{btn}</li>;
            }

            return (
              <li key={ref.name}>
                <ContextMenu>
                  <ContextMenuTrigger>{btn}</ContextMenuTrigger>
                  <ContextMenuContent>{menuContent}</ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function buildMenu(
  label: keyof typeof GROUP_META,
  ref: RefInfo,
  onRefAction?: (action: RefAction) => void,
): React.ReactNode | null {
  if (!onRefAction) return null;

  if (label === "Branches") {
    if (ref.is_head) {
      return (
        <>
          <ContextMenuItem disabled className="text-muted-foreground">
            Current branch
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onRefAction({ kind: "push", branchName: ref.shorthand })}>
            Push…
          </ContextMenuItem>
        </>
      );
    }
    return (
      <>
        <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-branch", branchName: ref.shorthand })}>
          Checkout {ref.shorthand}
        </ContextMenuItem>
        {ref.target_oid && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRefAction({ kind: "merge", oid: ref.target_oid!, label: ref.shorthand })}>
              Merge into current
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRefAction({ kind: "rebase", oid: ref.target_oid! })}>
              Rebase current onto {ref.shorthand}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRefAction({ kind: "push", branchName: ref.shorthand })}>
          Push…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onRefAction({ kind: "delete-branch", branchName: ref.shorthand })}
          className="text-destructive focus:text-destructive"
        >
          Delete {ref.shorthand}
        </ContextMenuItem>
      </>
    );
  }

  if (label === "Remotes" && ref.target_oid) {
    return (
      <>
        <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-remote-branch", remoteBranch: ref.shorthand })}>
          Checkout {ref.shorthand}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRefAction({ kind: "merge", oid: ref.target_oid!, label: ref.shorthand })}>
          Merge into current
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRefAction({ kind: "rebase", oid: ref.target_oid! })}>
          Rebase current onto {ref.shorthand}
        </ContextMenuItem>
      </>
    );
  }

  if (label === "Tags") {
    return (
      <>
        {ref.target_oid && (
          <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-tag", oid: ref.target_oid! })}>
            Checkout (detached)
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onRefAction({ kind: "push-tag", tagName: ref.shorthand })}>
          Push tag…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onRefAction({ kind: "delete-tag", tagName: ref.shorthand })}
          className="text-destructive focus:text-destructive"
        >
          Delete {ref.shorthand}
        </ContextMenuItem>
      </>
    );
  }

  return null;
}

interface Props {
  refs: RefInfo[];
  filter?: string;
  onSelectRef?: (ref: RefInfo) => void;
  onRefAction?: (action: RefAction) => void;
}

export function RefTree({ refs, filter, onSelectRef, onRefAction }: Props) {
  const local  = refs.filter((r) => r.kind === "local_branch");
  const remote = refs.filter((r) => r.kind === "remote_branch");
  const tags   = refs.filter((r) => r.kind === "tag");

  return (
    <div className="overflow-auto flex-1 py-1">
      <RefGroup label="Branches" refs={local}  filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} />
      <RefGroup label="Remotes"  refs={remote} filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} />
      <RefGroup label="Tags"     refs={tags}   filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} />
    </div>
  );
}
