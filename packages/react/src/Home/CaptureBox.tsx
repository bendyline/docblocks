import { useId, useMemo, useState, type FormEvent } from 'react';
import { parseCapture, type LocalDate } from '@bendyline/docblocks/properties';
import { dueLabel } from '../Tasks/task-model.js';

export interface CaptureAction {
  readonly label: string;
  /** Resolves true when the text was used and the box can be cleared. */
  readonly run: (text: string) => Promise<boolean>;
}

export interface CaptureBoxProps {
  /** The visible label, and the field's accessible name. */
  label: string;
  placeholder: string;
  today: LocalDate;
  /** The main action, run by Enter. */
  primary: CaptureAction;
  secondary?: readonly CaptureAction[];
  /** Show what a date typed in the text will be read as. */
  readsDates?: boolean;
  disabled?: boolean;
}

export function CaptureBox({
  label,
  placeholder,
  today,
  primary,
  secondary = [],
  readsDates = true,
  disabled,
}: CaptureBoxProps) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const hint = useMemo(() => {
    if (!readsDates || !text.trim()) return null;
    const capture = parseCapture(text, today);
    return capture.due ? `Due ${dueLabel(capture.due, today).text.toLowerCase()}` : null;
  }, [readsDates, text, today]);

  const run = async (action: CaptureAction) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      if (await action.run(text)) setText('');
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(primary);
  };

  return (
    <form className="db-capture" onSubmit={submit}>
      <label className="db-capture-label" htmlFor={id}>
        {label}
      </label>
      <div className="db-capture-row">
        <input
          id={id}
          className="db-capture-input"
          type="text"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          enterKeyHint="done"
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="db-page-primary"
          disabled={disabled || busy || !text.trim()}
        >
          {primary.label}
        </button>
        {secondary.map((action) => (
          <button
            key={action.label}
            type="button"
            className="db-page-secondary"
            disabled={disabled || busy || !text.trim()}
            onClick={() => void run(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
      <p className="db-capture-hint" id={`${id}-hint`} aria-live="polite">
        {hint ?? ' '}
      </p>
    </form>
  );
}
