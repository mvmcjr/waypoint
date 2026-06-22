import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { InputField } from "@/lib/plugins/types";

interface Props {
  title: string;
  fields: InputField[];
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}

function initialValue(f: InputField): unknown {
  if (f.default !== undefined) return f.default;
  if (f.type === "confirm") return false;
  if (f.type === "select") return f.options?.[0] ?? "";
  return "";
}

/** Collects values for a plugin command's declared inputs (or an api.prompt call). */
export function PluginInputDialog({ title, fields, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.id, initialValue(f)])),
  );

  function set(id: string, v: unknown) {
    setValues((prev) => ({ ...prev, [id]: v }));
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {fields.map((f) => (
            <div key={f.id} className="flex flex-col gap-1">
              {f.type !== "confirm" && (
                <label className="text-xs text-muted-foreground">{f.label ?? f.id}</label>
              )}
              {f.type === "text" && (
                <Input
                  value={String(values[f.id] ?? "")}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.id, e.target.value)}
                  autoFocus
                />
              )}
              {f.type === "select" && (
                <Select value={String(values[f.id] ?? "")} onValueChange={(v) => v !== null && set(f.id, v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.options ?? []).map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {f.type === "confirm" && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={Boolean(values[f.id])}
                    onChange={(e) => set(f.id, e.target.checked)}
                  />
                  {f.label ?? f.id}
                </label>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onSubmit(values)}>Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
