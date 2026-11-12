"use client";

import { useRef, useState } from "react";
import { LIBRARY_API_BASE, libraryRequest } from "../api-client";
import type { Paper, PaperSupplement, SupplementMutationResponse } from "../contracts";
import { formatFileSize } from "../presentation";
import "./paper-supplements.css";

type Props = {
  paper: Paper;
  disabled: boolean;
  onSaved: (response: SupplementMutationResponse) => void;
  onBusyChange: (busy: boolean) => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export function PaperSupplements({ paper, disabled, onSaved, onBusyChange }: Props) {
  const [action, setAction] = useState<"import" | "remove" | "open" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const unavailable = disabled || action !== null;
  const files = paper.supplements ?? [];
  const desktop = typeof window === "undefined" ? undefined : window.literatureDesktop;
  const path = `/papers/${encodeURIComponent(paper.id)}/supplements`;

  async function run(kind: NonNullable<typeof action>, operation: () => Promise<void>) {
    if (disabled || busy.current) return;
    busy.current = true;
    setAction(kind);
    setError("");
    setStatus("");
    onBusyChange(true);
    try {
      await operation();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      busy.current = false;
      setAction(null);
      onBusyChange(false);
    }
  }

  const addFiles = (selection: File[]) => run("import", async () => {
    let added = 0;
    let duplicates = 0;
    const failures = [];
    for (const file of selection) {
      try {
        const result = desktop
          ? await desktop.importSupplement(paper.id, file)
          : await libraryRequest<SupplementMutationResponse>(`${path}?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          });
        onSaved(result);
        if (result.alreadyImported) duplicates += 1;
        else added += 1;
      } catch (failure) {
        failures.push(`${file.name} · ${errorMessage(failure)}`);
      }
    }
    setStatus([added ? `已添加 ${added} 份` : "", duplicates ? `${duplicates} 份已存在` : ""].filter(Boolean).join("，"));
    setError(failures.join("\n"));
  });

  const remove = (file: PaperSupplement) => {
    if (!window.confirm(`移除本机归档中的「${file.name}」吗？`)) return;
    void run("remove", async () => {
      const result = desktop
        ? await desktop.removeSupplement(paper.id, file.id)
        : await libraryRequest<SupplementMutationResponse>(`${path}/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      onSaved(result);
      setStatus("已移除补充材料");
    });
  };

  return (
    <div className="paper-supplements" aria-busy={action !== null}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = unavailable ? "none" : "copy";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files));
      }}>
      {files.length ? (
        <ul className="supplement-file-list" aria-label="补充材料文件">
          {files.map((file) => (
            <li key={file.id}>
              <div>
                {desktop ? (
                  <button type="button" className="supplement-file-name" disabled={unavailable}
                    onClick={() => void run("open", async () => {
                      if (await desktop.openSupplement(paper.id, file.id) === "revealed") {
                        setStatus("已在 Finder 中显示文件");
                      }
                    })}>{file.name}</button>
                ) : (
                  <a className="supplement-file-name" href={`${LIBRARY_API_BASE}${path}/${encodeURIComponent(file.id)}`}>{file.name}</a>
                )}
                <small>{formatFileSize(file.sizeBytes)}</small>
              </div>
              <button type="button" className="secondary-button" disabled={unavailable} aria-label={`移除 ${file.name}`} onClick={() => remove(file)}>移除</button>
            </li>
          ))}
        </ul>
      ) : <p className="supplement-empty">还没有补充材料</p>}
      <div className="supplement-add-row">
        <button type="button" className="secondary-button" disabled={unavailable} onClick={() => inputRef.current?.click()}>
          {action === "import" ? "正在添加…" : "添加文件"}
        </button>
        <small>可多选或拖入文件，每份最多 500 MiB</small>
        <input ref={inputRef} type="file" multiple hidden disabled={unavailable} aria-label="选择补充材料文件"
          onChange={(event) => {
            const selection = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (selection.length) void addFiles(selection);
          }} />
      </div>
      {status && <p className="supplement-status" role="status">{status}</p>}
      {error && <p className="supplement-error" role="alert">{error}</p>}
    </div>
  );
}
