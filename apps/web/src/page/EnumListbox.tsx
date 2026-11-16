import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

type EnumListboxProps = {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label?: string;
  "aria-describedby"?: string;
  invalid?: boolean;
  disabled?: boolean;
};

const TYPEAHEAD_DELAY = 1000;

export function EnumListbox({
  value,
  options,
  onChange,
  label,
  "aria-describedby": describedBy,
  invalid = false,
  disabled = false,
}: EnumListboxProps) {
  const baseId = useId().replace(/:/g, "");
  const buttonId = `${baseId}-button`;
  const listboxId = `${baseId}-listbox`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.indexOf(value)));
  const [query, setQuery] = useState("");

  const clearQuery = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setQuery("");
  };

  const close = (returnFocus = false) => {
    setOpen(false);
    clearQuery();
    if (returnFocus) buttonRef.current?.focus();
  };

  const openListbox = (index = Math.max(0, options.indexOf(value))) => {
    setActiveIndex(index);
    setOpen(true);
  };

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listboxRef.current?.focus();
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, baseId, open]);

  const choose = (index: number) => {
    const next = options[index];
    if (next !== undefined) onChange(next);
    close(true);
  };

  const typeAhead = (character: string) => {
    const nextQuery = `${query}${character}`.toLowerCase();
    const match = options.findIndex((option) => option.toLowerCase().startsWith(nextQuery));
    setQuery(nextQuery);
    if (match >= 0) setActiveIndex(match);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(clearQuery, TYPEAHEAD_DELAY);
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openListbox(Math.max(0, options.indexOf(value)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openListbox(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openListbox();
    }
  };

  const onListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeAhead(event.key);
    }
  };

  const activeOption = options[activeIndex];
  const labelId = label ? `${baseId}-label` : undefined;
  return (
    <div className="enum-listbox" ref={rootRef}>
      {label && <span className="enum-listbox-label" id={labelId}>{label}</span>}
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="enum-listbox-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openListbox())}
        onKeyDown={onButtonKeyDown}
      >
        <span className="enum-listbox-value">
          {open && query ? <><span className="enum-listbox-query-label">jump</span> <span className="enum-listbox-query">{query}</span></> : (value || "—")}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="enum-listbox-menu"
          role="listbox"
          aria-label={label}
          aria-activedescendant={activeOption === undefined ? undefined : `${baseId}-option-${activeIndex}`}
          aria-labelledby={labelId}
          tabIndex={0}
          onKeyDown={onListboxKeyDown}
        >
          {options.map((option, index) => {
            const matched = query && index === activeIndex && option.toLowerCase().startsWith(query);
            return (
              <div
                key={option}
                id={`${baseId}-option-${index}`}
                className={`enum-listbox-option${index === activeIndex ? " is-active" : ""}`}
                role="option"
                aria-selected={option === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span>{matched ? <><u>{option.slice(0, query.length)}</u>{option.slice(query.length)}</> : option}</span>
                {option === value && <span aria-hidden="true">✓</span>}
              </div>
            );
          })}
          <div className="enum-listbox-hint" aria-hidden="true">↑↓ move · type to jump · enter pick · esc close</div>
        </div>
      )}
    </div>
  );
}
