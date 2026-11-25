import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { RecordSubjectsResponse } from '@ledger/contracts';
import {
  newSubjectNote,
  subjectOnFile,
  suggestionCount,
  suggestSubjects,
  type SubjectKind,
  type SubjectOption,
} from './subject-picker.js';

/** Waits this long after the last keystroke before reading the subjects on file. */
const TYPING_PAUSE_MS = 200;

/**
 * A field for the operator's own id of a person, aircraft, flight, site or component: an accessible combobox that
 * offers the subjects of those kinds already on file by id and name, searched as the person types. Any id is still
 * taken; with `sayNew`, an id no record names yet is called out as a new subject before anything is recorded.
 */
export function SubjectPicker({
  client,
  sourceId,
  id,
  kinds,
  value,
  onChange,
  onChoose,
  sayNew = false,
  required,
  readOnly,
  placeholder,
}: {
  client: LedgerClient;
  sourceId: string;
  id: string;
  kinds: readonly SubjectKind[];
  value: string;
  onChange: (value: string) => void;
  /** Called when a subject on file is chosen from the list, with its kind. */
  onChoose?: (option: SubjectOption) => void;
  sayNew?: boolean;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const statusId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SubjectOption[] | null>(null);
  const [more, setMore] = useState(false);
  const [active, setActive] = useState(-1);
  const [onFile, setOnFile] = useState<boolean | undefined>(undefined);
  const searching = kinds.length > 0 && !readOnly;
  const kindsKey = kinds.join(',');
  const read = (path: string) => client.request<RecordSubjectsResponse>(path);

  useEffect(() => {
    if (!searching || !open) return;
    let stopped = false;
    const timer = setTimeout(() => {
      suggestSubjects(read, sourceId, kinds, value)
        .then((found) => {
          if (stopped) return;
          setOptions(found.options);
          setMore(found.more);
          setActive(-1);
        })
        .catch(() => !stopped && setOptions([]));
    }, TYPING_PAUSE_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, sourceId, kindsKey, value, open, searching]);

  useEffect(() => {
    setOnFile(undefined);
    const typed = value.trim();
    if (!searching || !sayNew || !typed) return;
    let stopped = false;
    const timer = setTimeout(() => {
      subjectOnFile(read, sourceId, kinds, typed)
        .then((found) => !stopped && setOnFile(found))
        .catch(() => undefined);
    }, TYPING_PAUSE_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, sourceId, kindsKey, value, sayNew, searching]);

  function choose(option: SubjectOption) {
    onChange(option.id);
    onChoose?.(option);
    setOpen(false);
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    const count = options?.length ?? 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      if (!count) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + count) % count);
    } else if (event.key === 'Enter' && open && active >= 0 && options?.[active]) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  const shown = open && searching && options !== null;
  const typed = value.trim();
  return (
    <div className="subject-picker">
      <input
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => searching && setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={searching ? key : undefined}
        readOnly={readOnly}
        required={required}
        maxLength={200}
        placeholder={placeholder}
        autoComplete="off"
        {...(searching
          ? {
              role: 'combobox',
              'aria-autocomplete': 'list' as const,
              'aria-expanded': shown,
              'aria-controls': listId,
              'aria-describedby': statusId,
              ...(shown && active >= 0 ? { 'aria-activedescendant': `${listId}-${active}` } : {}),
            }
          : {})}
      />
      {searching && (
        <ul id={listId} role="listbox" aria-label="Subjects on file" className="subject-picker-list" hidden={!shown}>
          {options?.map((option, index) => (
            <li
              key={`${option.kind}/${option.id}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="subject-picker-option"
              // Chosen before the field loses focus, which closes the list.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              <strong>{option.name ?? option.id}</strong>
              <small>
                {option.name ? `${option.id} · ` : ''}
                {option.kind}
              </small>
            </li>
          ))}
        </ul>
      )}
      {searching && (
        <small id={statusId} role="status" className="records-help">
          {shown ? suggestionCount(options.length, more, typed) : ''}
        </small>
      )}
      {sayNew && searching && typed && onFile === false && (
        <small className="records-help subject-picker-new" data-testid="new-subject-note">
          {newSubjectNote(typed, kinds)}
        </small>
      )}
    </div>
  );
}
