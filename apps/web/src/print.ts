/**
 * Opens every folded section just before printing and folds them again afterwards, so a printed page holds what the
 * screen shows only on request. A section that was open stays open.
 */
export function openFoldedSectionsForPrint(): () => void {
  let opened: HTMLDetailsElement[] = [];
  const before = () => {
    opened = [...document.querySelectorAll<HTMLDetailsElement>('details:not([open])')];
    for (const details of opened) details.open = true;
  };
  const after = () => {
    for (const details of opened) details.open = false;
    opened = [];
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  return () => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  };
}
