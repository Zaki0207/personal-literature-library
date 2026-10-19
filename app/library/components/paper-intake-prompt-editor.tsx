"use client";

import { useEffect, useId, useRef, useState } from "react";
import { libraryRequest } from "../api-client";
import type { BackupStatus } from "../contracts";
import "./paper-intake-prompt-editor.css";

export type PaperIntakePromptTemplateResponse = {
  promptTemplate: string;
  defaultPromptTemplate: string;
  usingDefault: boolean;
  backup?: BackupStatus;
};

export type PaperIntakePromptEditorProps = {
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onSaved?: (backup?: BackupStatus) => void;
};

const MAX_PROMPT_LENGTH = 40000;

export function PaperIntakePromptEditor({
  disabled,
  onDirtyChange,
  onBusyChange,
  onSaved,
}: PaperIntakePromptEditorProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [template, setTemplate] = useState<PaperIntakePromptTemplateResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [action, setAction] = useState<"load" | "save" | "reset" | null>("load");
  const [reloadCount, setReloadCount] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const dirty = template !== null && draft !== template.promptTemplate;
  const busy = action !== null;
  const blocked = disabled || busy;
  const valid = Boolean(draft.trim()) && draft.length <= MAX_PROMPT_LENGTH;

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    onBusyChange?.(true);
    void libraryRequest<PaperIntakePromptTemplateResponse>("/paper-intake/prompt-template", {
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) return;
      setTemplate(response);
      setDraft(response.promptTemplate);
      onDirtyChange?.(false);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "提示词加载失败，请重试。");
    }).finally(() => {
      if (!controller.signal.aborted) { setAction(null); onBusyChange?.(false); }
    });
    return () => controller.abort();
  }, [reloadCount, onBusyChange, onDirtyChange]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const updateTemplate = async (nextAction: "save" | "reset") => {
    if (blocked || !template || (nextAction === "save" && (!dirty || !valid))) return;
    const controller = new AbortController();
    requestRef.current = controller;
    onBusyChange?.(true);
    setAction(nextAction);
    setError("");
    setMessage("");
    try {
      const response = await libraryRequest<PaperIntakePromptTemplateResponse>(
        nextAction === "reset" ? "/paper-intake/prompt-template/reset" : "/paper-intake/prompt-template",
        {
          method: nextAction === "reset" ? "POST" : "PUT",
          ...(nextAction === "save" ? { body: JSON.stringify({ promptTemplate: draft }) } : {}),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      setTemplate(response);
      setDraft(response.promptTemplate);
      onDirtyChange?.(false);
      setMessage(nextAction === "reset" ? "已恢复默认提示词。" : "提示词已保存。后续添加及雷达候选核对会使用这份提示词。");
      onSaved?.(response.backup);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "提示词保存失败，修改仍保留，请重试。");
    } finally {
      if (!controller.signal.aborted) { setAction(null); onBusyChange?.(false); }
    }
  };

  return <section className={`paper-intake-prompt${expanded ? " is-expanded" : ""}`}
    data-paper-intake-prompt-editor aria-busy={busy}>
    <button type="button" className="paper-intake-prompt-toggle" data-paper-intake-prompt-toggle
      aria-expanded={expanded} aria-controls={`${id}-panel`}
      aria-label={`${expanded ? "收起" : "展开"}添加论文提示词`}
      onClick={() => setExpanded((value) => !value)}>
      <span className="paper-intake-prompt-title"><span className="paper-intake-prompt-chevron" aria-hidden="true">›</span>添加论文提示词</span>
      <span className="paper-intake-prompt-badges">
        {template ? <span>{template.usingDefault ? "默认提示词" : "自定义提示词"}</span>
          : <span>{action === "load" ? "正在读取…" : "暂时不可用"}</span>}
        {dirty && <span className="is-dirty">未保存</span>}
        <span className="paper-intake-prompt-toggle-label">{expanded ? "收起" : "查看与编辑"}</span>
      </span>
    </button>

    {error && <div className="paper-intake-prompt-error" role="alert">
      <span>{error}</span>
      {!template && <button type="button" data-paper-intake-prompt-retry disabled={blocked}
        onClick={() => {
          onBusyChange?.(true);
          setAction("load"); setError(""); setMessage(""); setReloadCount((value) => value + 1);
        }}>重试</button>}
    </div>}

    {expanded && <div className="paper-intake-prompt-panel" id={`${id}-panel`}>
      <p className="paper-intake-prompt-help" id={`${id}-help`}>
        可以编辑全文；请保留 JSON 输出字段，以便论文资料正常填入。
      </p>
      {template ? <>
        <label className="paper-intake-prompt-field" htmlFor={`${id}-input`}>
          <span className="sr-only">提示词内容</span>
          <textarea id={`${id}-input`} data-paper-intake-prompt-input value={draft}
            aria-describedby={`${id}-help ${id}-validation`} spellCheck={false} rows={9}
            maxLength={MAX_PROMPT_LENGTH} disabled={blocked}
            onChange={(event) => {
              const value = event.target.value;
              // Publish alongside the draft so the next action cannot use an
              // older saved template while waiting for a parent effect.
              onDirtyChange?.(value !== template.promptTemplate);
              setDraft(value); setMessage(""); setError("");
            }} />
        </label>
        <div className="paper-intake-prompt-validation" id={`${id}-validation`} role="status">
          <span>{!valid ? "提示词不能为空，且不能超过 40,000 字符。" : dirty ? "修改尚未保存，请先保存或取消修改，再继续添加论文。" : message || "已保存；后续添加及雷达候选核对会使用。"}</span>
          <span>{draft.length.toLocaleString("zh-CN")} / 40,000</span>
        </div>
        <div className="paper-intake-prompt-actions">
          <button type="button" data-paper-intake-prompt-reset disabled={blocked || (template.usingDefault && !dirty)}
            onClick={() => { void updateTemplate("reset"); }}>{action === "reset" ? "正在恢复…" : "恢复默认"}</button>
          {dirty && <button type="button" data-paper-intake-prompt-cancel disabled={blocked}
            onClick={() => { onDirtyChange?.(false); setDraft(template.promptTemplate); setError(""); setMessage("已取消尚未保存的修改。"); }}>取消修改</button>}
          <button type="button" className="paper-intake-prompt-save" data-paper-intake-prompt-save
            disabled={blocked || !dirty || !valid} onClick={() => { void updateTemplate("save"); }}>
            {action === "save" ? "正在保存…" : "保存提示词"}
          </button>
        </div>
        <p className="paper-intake-prompt-scope">编辑和保存不会调用 AI。雷达生成候选时的提示词仍在雷达中单独设置。</p>
      </> : action === "load" && <p className="paper-intake-prompt-loading" role="status">正在读取提示词…</p>}
    </div>}
  </section>;
}
