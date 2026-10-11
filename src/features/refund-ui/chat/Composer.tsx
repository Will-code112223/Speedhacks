"use client";

/**
 * The message box pinned to the bottom of the chat column. Enter sends,
 * Shift+Enter adds a line, and nothing is sent twice: the box keeps the text
 * until the controller accepts it.
 */

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Button } from "../ui/primitives";
import { SendIcon } from "../ui/icons";
import styles from "./Composer.module.css";

const MAX_HEIGHT = 168;

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
}

export default function Composer({ value, onChange, onSend, busy, busyLabel, placeholder, hint, suggestions, textareaRef }: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
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
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
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
      </form>
      <p id={hintId} className={styles.hint}>
        {hint ? <span>{hint}</span> : null}
        <span className={styles.keys}>
          <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </span>
      </p>
    </div>
  );
}
