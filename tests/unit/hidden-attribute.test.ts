import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// An element hidden with the `hidden` attribute stays on screen when a rule for one of its classes sets `display`,
// because that rule outranks the browser's own `[hidden] { display: none }`. Such a class needs a `[hidden]` rule.

const source = new URL('../../apps/web/src/', import.meta.url).pathname;
const styles = [
  ...readdirSync(join(source, 'styles')).map((name) => join(source, 'styles', name)),
  new URL('../../packages/ui/src/styles.css', import.meta.url).pathname,
]
  .filter((path) => path.endsWith('.css'))
  .map((path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

/** Classes a rule shows with a `display` other than none, outside print. */
function displayedClasses(): Set<string> {
  const shown = new Set<string>();
  const screen = styles.replace(/@media print\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const [, selectors, body] of screen.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|;|\s)display:\s*(?!none)/.test(body!)) continue;
    for (const selector of selectors!.split(','))
      for (const [, name] of selector.trim().matchAll(/\.([A-Za-z0-9_-]+)(?![A-Za-z0-9_-]*\[hidden\])(?=[^\s>+~]*$)/g))
        shown.add(name!);
  }
  return shown;
}

/** Each element the web app hides with the attribute, as the classes it carries. */
function hiddenElements(): { file: string; classes: string[] }[] {
  const found: { file: string; classes: string[] }[] = [];
  for (const name of readdirSync(source, { recursive: true }) as string[]) {
    if (!name.endsWith('.tsx')) continue;
    const text = readFileSync(join(source, name), 'utf8');
    for (const [tag] of text.matchAll(/<[a-z]+\s(?:[^<>]|=>)*?\shidden=\{/g)) {
      const classes = /className="([^"]+)"/.exec(tag);
      if (classes) found.push({ file: name, classes: classes[1]!.split(/\s+/) });
    }
  }
  return found;
}

describe('the hidden attribute', () => {
  test('hides every element the web app hides with it', () => {
    const shown = displayedClasses();
    const elements = hiddenElements();
    expect(elements.length).toBeGreaterThan(0);
    const visible = elements.filter(
      ({ classes }) =>
        classes.some((name) => shown.has(name)) &&
        !classes.some((name) => new RegExp(`\\.${name}\\[hidden\\]`).test(styles)),
    );
    expect(visible).toEqual([]);
  });
});
