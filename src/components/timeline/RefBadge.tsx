interface Props {
  name: string;
  isHead?: boolean;
}

export function RefBadge({ name, isHead }: Props) {
  const base = "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold mr-1 shrink-0";
  const style = isHead
    ? `${base} bg-green-500/20 text-green-400 border border-green-500/40`
    : `${base} bg-blue-500/15 text-blue-300 border border-blue-500/30`;

  return <span className={style}>{name}</span>;
}
