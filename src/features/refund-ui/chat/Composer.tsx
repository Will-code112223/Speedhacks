"use client";

/**
 * The message box pinned to the bottom of the chat column. Enter sends,
 * Shift+Enter adds a line, and nothing is sent twice: the box keeps the text
 * until the controller accepts it.
 */

import { useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Button } from "../ui/primitives";
import { CloseIcon, FileIcon, PaperclipIcon, SendIcon } from "../ui/icons";
import styles from "./Composer.module.css";

const MAX_HEIGHT = 168;

/** Matches the server: at most 5 files, 10 MB each (src/server/config.ts upload limits). */
export const MAX_ATTACH_FILES = 5;
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** HEIC is left out until the server accepts it (src/server/documents/storage.ts ALLOWED_MIME_TYPES). */
export const ATTACH_ACCEPT = "application/pdf,image/png,image/jpeg";
const ACCEPTED_TYPES = new Set(ATTACH_ACCEPT.split(","));
const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g)$/i;

/** Picks the files that may be attached, with one error line for the rest. */
export function screenFiles(files: readonly File[], alreadyHeld: number): { accepted: File[]; error: string | null } {
  const accepted: File[] = [];
  const problems: string[] = [];
  for (const file of files) {
    if (!ACCEPTED_TYPES.has(file.type) && !ACCEPTED_EXTENSIONS.test(file.name)) {
      problems.push(`${file.name} is not a PDF, PNG or JPG file.`);
    } else if (file.size > MAX_ATTACH_BYTES) {
      problems.push(`${file.name} is larger than 10 MB.`);
    } else if (alreadyHeld + accepted.length >= MAX_ATTACH_FILES) {
      problems.push(`You can attach up to ${MAX_ATTACH_FILES} files at a time.`);
      break;
    } else {
      accepted.push(file);
    }
  }
  return { accepted, error: problems.length > 0 ? problems.join(" ") : null };
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Resolves true when the message was accepted; the box then clears. */
  onSend: (text: string) => Promise<boolean>;
  busy: boolean;
  busyLabel: string;
  placeholder: string;
  hint: string | null;
  suggestions?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Files held for a case that does not exist yet, shown as removable chips. */
  pendingFiles?: readonly File[];
  /**
   * Adds files: held as pending before a case exists, uploaded at once to an open case.
   * Resolves false when the files were not accepted. Absent hides the attach control.
   */
  onAttach?: (files: File[]) => Promise<boolean>;
  onRemovePending?: (index: number) => void;
  /** True when attaching uploads immediately (an open case), so the box shows "Uploading…". */
  uploadsImmediately?: boolean;
}

export default function Composer({
  value,
  onChange,
  onSend,
  busy,
  busyLabel,
  placeholder,
  hint,
  suggestions,
  textareaRef,
  pendingFiles = [],
  onAttach,
  onRemovePending,
  uploadsImmediately = false,
}: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const attach = async (list: FileList | readonly File[] | null) => {
    if (!onAttach || !list || list.length === 0 || uploading) return;
    const held = uploadsImmediately ? 0 : pendingFiles.length;
    const { accepted, error } = screenFiles(Array.from(list), held);
    setAttachError(error);
    if (accepted.length === 0) return;
    if (uploadsImmediately) setUploading(true);
    try {
      const ok = await onAttach(accepted);
      if (!ok && uploadsImmediately && error === null) setAttachError("The files were not attached. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!onAttach || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!onAttach) return;
    event.preventDefault();
    setDragging(false);
    void attach(event.dataTransfer.files);
  };
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const sending = useRef(false);

  const setRefs = (node: HTMLTextAreaElement | null) => {
    localRef.current = node;
    if (typeof textareaRef === "function") textareaRef(node);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = node;
  };

  // Grow with the text up to a limit, then scroll inside.
  useLayoutEffect(() => {
    const node = localRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const text = value.trim();
  const canSend = text.length > 0 && !busy;

  const send = async () => {
    if (!canSend || sending.current) return;
    sending.current = true;
    try {
      const accepted = await onSend(text);
      if (accepted) onChange("");
    } finally {
      sending.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className={styles.wrap}>
      {suggestions}
      <form
        className={styles.composer}
        data-dragging={dragging || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="composer"
      >
        <label htmlFor={inputId} className={styles.label}>
          Your message
        </label>
        <textarea
          id={inputId}
          ref={setRefs}
          className={styles.input}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-describedby={hintId}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="composer-input"
        />
        {onAttach ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className={styles.fileInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const files = event.target.files ? Array.from(event.target.files) : [];
                event.target.value = "";
                void attach(files);
              }}
              data-testid="composer-file-input"
            />
            <Button
              type="button"
              variant="secondary"
              size="small"
              className={styles.attach}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              busy={uploading}
              busyLabel="Uploading files"
              aria-label="Attach files"
              title="Attach files"
              data-testid="composer-attach"
            >
              {uploading ? null : <PaperclipIcon />}
            </Button>
          </>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="small"
          className={styles.send}
          disabled={!busy && text.length === 0}
          busy={busy}
          busyLabel={busyLabel}
          aria-label="Send message"
          data-testid="composer-send"
        >
          {busy ? null : <SendIcon />}
          <span className={styles.sendLabel}>{busy ? "Sending" : "Send"}</span>
        </Button>
        {onAttach && (pendingFiles.length > 0 || uploading || attachError) ? (
          <div className={styles.files}>
            {pendingFiles.length > 0 ? (
              <ul className={styles.chips} aria-label="Files to send">
                {pendingFiles.map((file, index) => (
                  <li className={styles.chip} key={`${file.name}-${index}`} data-testid="composer-chip">
                    <FileIcon />
                    <span className={styles.chipName}>{file.name}</span>
                    <button
                      type="button"
                      className={styles.chipRemove}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => onRemovePending?.(index)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {uploading ? (
              <p className={styles.uploading} role="status">
                Uploading…
              </p>
            ) : null}
            {attachError ? (
              <p className={styles.attachError} role="alert" data-testid="composer-attach-error">
                {attachError}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
      <p id={hintId} className={styles.hint}>
        {hint || onAttach ? (
          <span className={styles.hintText}>
            {hint ? <span>{hint}</span> : null}
            {onAttach ? <span className={styles.attachHint}>PDF, PNG or JPG, up to 10 MB each</span> : null}
          </span>
        ) : null}
        <span className={styles.keys}>
          <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </span>
      </p>
    </div>
  );
}
