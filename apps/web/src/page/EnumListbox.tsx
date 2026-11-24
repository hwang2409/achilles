import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const display = (option: string) => {
  if (!option) return "—";
  try { return String(JSON.parse(option)); } catch { return option; }
};

export function EnumListbox({ value, options, onChange, id, name, required, label, "aria-describedby": describedBy, invalid, disabled }: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  required?: boolean;
  label?: string;
  "aria-describedby"?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const generated = useId();
  const trigger = id ?? generated;
  return <div className="grid min-w-0 gap-1.5">
    {label && <Label htmlFor={trigger} className="text-xs text-muted-foreground">{label}</Label>}
    <Select value={`enum:${value}`} onValueChange={(next) => onChange(next.slice(5))} disabled={disabled}>
      <SelectTrigger id={trigger} name={name} aria-required={required} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="w-full max-[760px]:min-h-11"><SelectValue>{display(value)}</SelectValue></SelectTrigger>
      <SelectContent aria-label={label} position="popper" className="min-w-(--radix-select-trigger-width)">
        {options.map((option) => <SelectItem key={option} value={`enum:${option}`}>{display(option)}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
