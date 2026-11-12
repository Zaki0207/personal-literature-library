"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import { noteRuns, serializeNoteEditor } from "../../../lib/note-format.mjs";
import "./note-editor.css";

export function NoteText({ value }: { value: string }) {
  return <>{noteRuns(value).map((run, index) => run.bold ? <strong key={index}>{run.text}</strong> : run.text)}</>;
}

export function NoteEditor({ value, onChange, label, placeholder = "记录你的想法…", disabled = false, inputProps = {}, minHeight = 120 }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  inputProps?: HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
  minHeight?: number;
}) {
  const inputRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef<string | null>(null);
  const [bold, setBold] = useState(false);
  const sync = () => {
    if (!inputRef.current) return;
    const next = serializeNoteEditor(inputRef.current);
    if (next !== lastValueRef.current) { lastValueRef.current = next; onChange(next); }
    setBold(window.document.queryCommandState("bold"));
  };
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || value === lastValueRef.current) return;
    const fragment = window.document.createDocumentFragment();
    for (const run of noteRuns(value)) {
      if (run.bold) { const strong = window.document.createElement("strong"); strong.textContent = run.text; fragment.append(strong); }
      else fragment.append(window.document.createTextNode(run.text));
    }
    input.replaceChildren(fragment);
    lastValueRef.current = value;
  }, [value]);
  useEffect(() => {
    const selection = () => {
      if (inputRef.current?.contains(window.getSelection()?.anchorNode ?? null)) setBold(window.document.queryCommandState("bold"));
    };
    window.document.addEventListener("selectionchange", selection);
    return () => window.document.removeEventListener("selectionchange", selection);
  }, []);
  const toggleBold = () => {
    if (disabled) return;
    inputRef.current?.focus({ preventScroll: true });
    window.document.execCommand("bold");
    sync();
  };
  return <div className={`note-editor${disabled ? " is-disabled" : ""}`}>
    <div className="note-editor-tools">
      <button type="button" className="note-bold-button" aria-label="加粗" aria-pressed={bold} title="加粗 ⌘/Ctrl+B"
        disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={toggleBold}><strong>B</strong></button>
      <small>⌘ / Ctrl + B 加粗</small>
    </div>
    <div {...inputProps} ref={inputRef} className="note-editor-input" data-note-input
      style={{ minHeight }} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label}
      aria-disabled={disabled} tabIndex={disabled ? -1 : 0} data-placeholder={placeholder}
      onInput={sync} onBlur={sync}
      onPaste={(event) => {
        event.preventDefault();
        window.document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        sync();
      }}
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") {
          event.preventDefault(); event.stopPropagation(); toggleBold();
        }
      }} />
  </div>;
}
