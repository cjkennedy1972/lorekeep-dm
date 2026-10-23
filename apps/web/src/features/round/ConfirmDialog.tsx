import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href]';

type Props = {
  titleId: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Destructive-action confirm. Focuses the cancel button, traps Tab, Escape cancels, focus returns to the opener. */
export function ConfirmDialog({
  titleId,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  // Keeps the listener below from closing over a stale onCancel while the effect runs once per open.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button.secondary')?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') return cancel.current();
      if (e.key !== 'Tab') return;
      const items = [...box.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        ref={box}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
