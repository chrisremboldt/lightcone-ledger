/**
 * Finds controls the way a person would describe them: by form, label, button text or region
 * name. A locator is resolved again each time it is used, so it follows the page as it changes.
 */

type Match = string | RegExp;

interface MatchOptions {
  exact?: boolean;
}

const tidy = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

function matches(candidate: string, wanted: Match, exact = false): boolean {
  if (wanted instanceof RegExp) return wanted.test(candidate);
  return exact ? candidate === tidy(wanted) : candidate.toLowerCase().includes(tidy(wanted).toLowerCase());
}

function referencedText(element: Element, attribute: string): string {
  const ids = tidy(element.getAttribute(attribute));
  if (!ids) return '';
  return tidy(
    ids
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

/** A wrapping label also contains its control, whose own text is not part of the name. */
function labelText(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as HTMLElement;
  for (const control of copy.querySelectorAll('input, select, textarea, button')) control.remove();
  return tidy(copy.textContent);
}

function names(element: Element): string[] {
  const found = [tidy(element.getAttribute('aria-label')), referencedText(element, 'aria-labelledby')];
  const labels = (element as HTMLInputElement).labels;
  if (labels) for (const label of labels) found.push(labelText(label));
  return found.filter(Boolean);
}

function named(element: Element, wanted: Match, exact?: boolean): boolean {
  return names(element).some((name) => matches(name, wanted, exact));
}

export function usable(element: Element): boolean {
  if (element.getClientRects().length === 0) return false;
  if (element.closest('[inert]')) return false;
  if (element.matches(':disabled')) return false;
  return true;
}

export class Locator {
  constructor(
    readonly description: string,
    private readonly resolve: () => Element[],
  ) {}

  elements(): Element[] {
    return this.resolve();
  }

  /** The first matching element a person could see and use right now. */
  element(): Element | undefined {
    return this.resolve().find(usable);
  }

  nth(index: number): Locator {
    return new Locator(`${this.description} #${index + 1}`, () => {
      const element = this.resolve()[index];
      return element ? [element] : [];
    });
  }

  private within(description: string, selector: string, keep: (element: Element) => boolean): Locator {
    return new Locator(`${this.description} › ${description}`, () =>
      this.resolve().flatMap((root) => [...root.querySelectorAll(selector)].filter(keep)),
    );
  }

  form(name: string): Locator {
    return this.within(`form “${name}”`, 'form', (element) => named(element, name, true));
  }

  region(name: string): Locator {
    return this.within(`region “${name}”`, 'section, [role="region"]', (element) => named(element, name, true));
  }

  /** Any element carrying this accessible label, such as a named list. */
  labelled(name: string): Locator {
    return this.within(`“${name}”`, '[aria-label], [aria-labelledby]', (element) => named(element, name, true));
  }

  dialog(name: string): Locator {
    return this.within(`dialog “${name}”`, 'dialog, [role="dialog"]', (element) => named(element, name, true));
  }

  testId(id: string): Locator {
    return this.within(`[${id}]`, `[data-testid="${id}"]`, () => true);
  }

  /** A text input, text area, select, checkbox or radio button, found by its label. */
  field(label: Match, options: MatchOptions = {}): Locator {
    return this.within(`field “${String(label)}”`, 'input, select, textarea', (element) =>
      named(element, label, options.exact),
    );
  }

  button(name: Match, options: MatchOptions = {}): Locator {
    return this.within(`button “${String(name)}”`, 'button, [role="button"]', (element) => {
      const text = tidy(element.getAttribute('aria-label')) || tidy(element.textContent);
      return matches(text, name, options.exact);
    });
  }

  heading(name: Match): Locator {
    return this.within(`heading “${String(name)}”`, 'h1, h2, h3, h4, h5, h6', (element) =>
      matches(tidy(element.textContent), name),
    );
  }

  /** The matching elements with this text somewhere inside them, such as the one card that names a pack. */
  containing(text: Match): Locator {
    return new Locator(`${this.description} containing “${String(text)}”`, () =>
      this.resolve().filter((element) => matches(tidy(element.textContent), text)),
    );
  }

  /** The innermost elements whose text matches. */
  text(text: Match, options: MatchOptions = {}): Locator {
    return this.within(`text “${String(text)}”`, '*', (element) => {
      if (!matches(tidy(element.textContent), text, options.exact)) return false;
      return ![...element.children].some((child) => matches(tidy(child.textContent), text, options.exact));
    });
  }
}

export const page = new Locator('page', () => [document.documentElement]);
