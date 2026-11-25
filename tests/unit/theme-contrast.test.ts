import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { themeChoice, themeStorageKey } from '../../apps/web/src/theme.js';

const stylesheet = readFileSync(new URL('../../packages/ui/src/styles.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');

type Theme = 'light' | 'dark';

/** Each colour property of the stylesheet's root, in each theme: light-dark(light, dark), or one colour for both. */
function palette(): Record<Theme, Map<string, string>> {
  const themes = { light: new Map<string, string>(), dark: new Map<string, string>() };
  const root = stylesheet.slice(
    stylesheet.indexOf(':root {'),
    stylesheet.indexOf('\n}', stylesheet.indexOf(':root {')),
  );
  for (const [, name, value] of root.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)) {
    const both = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(value!);
    if (both) {
      themes.light.set(name!, both[1]!);
      themes.dark.set(name!, both[2]!);
    } else if (/^#[0-9a-f]{6}$/i.test(value!)) {
      themes.light.set(name!, value!);
      themes.dark.set(name!, value!);
    }
  }
  return themes;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two colours. */
function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const surfaces = ['paper', 'sheet', 'side'];
const text = 4.5;
const controlBorder = 3;

/** [foreground, background, least ratio]: every pair the stylesheets put text or a control's edge on. */
const pairs: [string, string, number][] = [
  // Text on the page, a sheet and the side panels.
  ...[
    'ink',
    'ink-2',
    'muted',
    'faint',
    'magenta-ink',
    'amber',
    'plan',
    'flight',
    'advisory',
    'alert',
    'decision',
    'evidence',
  ].flatMap((ink) => surfaces.map((surface): [string, string, number] => [ink, surface, text])),
  // Badges and notices: the tone's text on its own soft background, and body text in a notice.
  ['plan', 'plan-soft', text],
  ['flight', 'flight-soft', text],
  ['advisory', 'advisory-soft', text],
  ['amber', 'amber-soft', text],
  ['alert', 'alert-soft', text],
  ['magenta-ink', 'magenta-soft', text],
  ['ink-2', 'amber-soft', text],
  ['ink-2', 'alert-soft', text],
  ['ink-2', 'plan-soft', text],
  ['ink', 'magenta-soft', text],
  // Filled buttons and markers.
  ['on-magenta', 'magenta', text],
  ['on-plan', 'plan', text],
  ['sheet', 'ink', text],
  // The edge of a button, a field or a select against the surfaces it sits on.
  ...surfaces.map((surface): [string, string, number] => ['line-2', surface, controlBorder]),
];

describe('the two themes', () => {
  const themes = palette();

  test.each(['light', 'dark'] as const)('the %s theme defines every colour the pairs use', (theme) => {
    const missing = [...new Set(pairs.flatMap(([one, other]) => [one, other]))].filter(
      (name) => !themes[theme].has(name),
    );
    expect(missing).toEqual([]);
  });

  test.each(
    (['light', 'dark'] as const).flatMap((theme) =>
      pairs.map(([foreground, background, least]) => ({ theme, foreground, background, least })),
    ),
  )('$theme: $foreground on $background reaches $least:1', ({ theme, foreground, background, least }) => {
    const ratio = contrast(themes[theme].get(foreground)!, themes[theme].get(background)!);
    expect(ratio, `${foreground} on ${background} in the ${theme} theme`).toBeGreaterThanOrEqual(least);
  });
});

describe('the theme choice', () => {
  test('a stored value is a choice only when it names a theme', () => {
    expect(themeChoice('light')).toBe('light');
    expect(themeChoice('dark')).toBe('dark');
    expect(themeChoice('system')).toBe('system');
    expect(themeChoice('sepia')).toBe('system');
    expect(themeChoice(null)).toBe('system');
  });

  test('the page applies the stored choice before the first paint, under the same key', () => {
    const head = page.slice(0, page.indexOf('</head>'));
    expect(head).toContain(`localStorage.getItem('${themeStorageKey}')`);
    expect(page.indexOf(`getItem('${themeStorageKey}')`)).toBeLessThan(page.indexOf('src/main.tsx'));
  });
});
