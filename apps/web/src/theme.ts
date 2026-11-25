import { useEffect, useState } from 'react';

/** Follow the system's setting, or keep one theme whatever it says. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const themeChoices: readonly (readonly [ThemeChoice, string])[] = [
  ['system', 'System theme'],
  ['light', 'Light theme'],
  ['dark', 'Dark theme'],
];

/** Where the choice is kept in the browser. index.html reads the same key before the first paint. */
export const themeStorageKey = 'ledger-theme';

/** A stored value read as a choice; anything else, or nothing, follows the system. */
export function themeChoice(stored: string | null | undefined): ThemeChoice {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function readChoice(): ThemeChoice {
  try {
    return themeChoice(window.localStorage.getItem(themeStorageKey));
  } catch {
    return 'system';
  }
}

/** Sets the theme on the page and keeps the choice; "system" removes both, so the system's setting applies. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  try {
    if (choice === 'system') window.localStorage.removeItem(themeStorageKey);
    else window.localStorage.setItem(themeStorageKey, choice);
  } catch {
    // A browser that keeps nothing still shows the chosen theme until the page is left.
  }
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** The person's theme choice, and a way to change it. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(readChoice);
  useEffect(() => {
    // Another tab of Ledger changed the choice.
    const follow = (event: StorageEvent) => {
      if (event.key !== themeStorageKey) return;
      const next = themeChoice(event.newValue);
      applyTheme(next);
      setChoice(next);
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
  return [
    choice,
    (next) => {
      applyTheme(next);
      setChoice(next);
    },
  ];
}
