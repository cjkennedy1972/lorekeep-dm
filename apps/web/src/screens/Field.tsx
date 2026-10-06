import type { InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  /** Extra description ids, e.g. a form-level error shared by several fields. */
  describedBy?: string;
  invalid?: boolean;
}

/** Label + input + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({
  id,
  label,
  error,
  hint,
  describedBy,
  invalid,
  ...input
}: Props) {
  const described = [hint && `${id}-hint`, error && `${id}-error`, describedBy]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        {...input}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={described || undefined}
      />
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Moves focus to the first field (by DOM order) that has an error. */
export function focusFirstError(ids: string[], errors: Record<string, string>) {
  const first = ids.find((id) => errors[id]);
  if (first) document.getElementById(first)?.focus();
}
