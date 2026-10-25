import { codeFont, TEXT_ROLE_CLASS, type TextRole } from './textRoles.js';
/**
 * Named typographic scales.
 *
 * An imported deck carries a per-element inline `font-size` (and often a
 * colour) taken from Keynote, which is why an import looks approximately right
 * but never *consistent*. Applying a font set rewrites those ad-hoc values into
 * semantic roles and moves the actual type into `theme.css`, so the deck
 * becomes editable as a design rather than as hundreds of individual numbers.
 *
 * Roles, largest to smallest: `title`, `heading`, `body`, `caption`, and
 * `base` as the catch-all. `code` uses monospace at caption size and is chosen explicitly.
 */

export interface FontRole {
  family: string;
  size: number;
  weight: number;
  lineHeight: number;
  letterSpacing: string;
  color?: string;
}

export interface FontSet {
  id: string;
  name: string;
  description: string;
  roles: Record<TextRole, FontRole>;
}

/**
 * Font stacks are deliberately system-first. A deck has to render identically
 * on a Linux conference laptop, and a webfont that fails to load silently
 * reflows every slide.
 */
const SANS = '"Helvetica Neue", Inter, "Segoe UI", system-ui, sans-serif';
const SERIF = 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif';
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace';

export const FONT_SETS: FontSet[] = [
  {
    id: 'research-talk',
    name: 'Research talk',
    description: 'Restrained sans, generous sizes. The default for conference talks.',
    roles: {
      title: { family: SANS, size: 96, weight: 700, lineHeight: 1.05, letterSpacing: '-0.03em' },
      heading: { family: SANS, size: 64, weight: 600, lineHeight: 1.1, letterSpacing: '-0.02em' },
      body: { family: SANS, size: 46, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
      caption: { family: SANS, size: 30, weight: 400, lineHeight: 1.3, letterSpacing: '0', color: '#6b7280' },
      code: codeFont({ size: 30, lineHeight: 1.3 }),
      base: { family: SANS, size: 42, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
    },
  },
  {
    id: 'bold-keynote',
    name: 'Bold keynote',
    description: 'Heavy display type for a big room and few words per slide.',
    roles: {
      title: { family: SANS, size: 128, weight: 800, lineHeight: 0.98, letterSpacing: '-0.04em' },
      heading: { family: SANS, size: 80, weight: 700, lineHeight: 1.05, letterSpacing: '-0.03em' },
      body: { family: SANS, size: 48, weight: 500, lineHeight: 1.25, letterSpacing: '-0.01em' },
      caption: { family: SANS, size: 32, weight: 500, lineHeight: 1.25, letterSpacing: '0', color: '#9ca3af' },
      code: codeFont({ size: 32, lineHeight: 1.25 }),
      base: { family: SANS, size: 44, weight: 500, lineHeight: 1.25, letterSpacing: '-0.01em' },
    },
  },
  {
    id: 'lecture',
    name: 'Lecture',
    description: 'Serif headings, plain body. Reads well over a long teaching session.',
    roles: {
      title: { family: SERIF, size: 88, weight: 700, lineHeight: 1.08, letterSpacing: '-0.01em' },
      heading: { family: SERIF, size: 56, weight: 600, lineHeight: 1.15, letterSpacing: '0' },
      body: { family: SANS, size: 46, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: SANS, size: 30, weight: 400, lineHeight: 1.3, letterSpacing: '0', color: '#6b7280' },
      code: codeFont({ size: 30, lineHeight: 1.3 }),
      base: { family: SANS, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
  },
  {
    id: 'technical',
    name: 'Technical',
    description: 'Monospace labels and captions, for diagram-heavy and code-heavy decks.',
    roles: {
      title: { family: SANS, size: 84, weight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' },
      heading: { family: SANS, size: 52, weight: 600, lineHeight: 1.15, letterSpacing: '-0.01em' },
      body: { family: SANS, size: 44, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: MONO, size: 28, weight: 400, lineHeight: 1.3, letterSpacing: '0', color: '#4b5563' },
      code: codeFont({ size: 28, lineHeight: 1.3 }),
      base: { family: MONO, size: 38, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
  },
];

export type RoleName = keyof FontSet['roles'];

/**
 * Classify a text element by the size Keynote gave it, relative to the largest
 * text in the deck.
 *
 * Absolute sizes cannot be used: one deck's body text is another's caption.
 * Ratios against the deck's own maximum are stable across decks and match how
 * the roles were laid out by whoever built the slides.
 */
export function roleForSize(size: number, maxSize: number): RoleName {
  if (maxSize <= 0) return 'base';
  const ratio = size / maxSize;
  if (ratio >= 0.85) return 'title';
  if (ratio >= 0.6) return 'heading';
  if (ratio >= 0.38) return 'body';
  if (ratio <= 0.3) return 'caption';
  return 'base';
}

/** Text length of an element's markup, tags stripped. */
export function proseLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').trim().length;
}

/**
 * The deck's typographic scale: the largest font size among *prose* elements.
 * Decorations (a lone 200px "+" between two figures) must not set the scale,
 * or every real title gets demoted to a heading and casting flattens the deck.
 */
export function deckProseMax(
  elements: Array<{ html: string; size: number }>,
): number {
  return Math.max(
    0,
    ...elements.filter((e) => proseLength(e.html) >= 3).map((e) => e.size),
  );
}

/**
 * The role to cast an element to. An explicit `role-*` class — set by the
 * importer or the sidebar dropdown — always wins; the size ratio is only the
 * fallback for untagged elements.
 */
export function roleForElement(
  classes: string[],
  size: number,
  maxProse: number,
): RoleName {
  for (const cls of classes) {
    const m = TEXT_ROLE_CLASS.exec(cls);
    if (m) return m[1] as RoleName;
  }
  return roleForSize(size || maxProse * 0.5, maxProse);
}

/** The CSS a font set contributes to `theme.css`. */
export function fontSetCss(set: FontSet): string {
  const rule = (selector: string, role: FontRole): string =>
    [
      `${selector} {`,
      `  font-family: ${role.family};`,
      `  font-size: ${role.size}px;`,
      `  font-weight: ${role.weight};`,
      `  line-height: ${role.lineHeight};`,
      `  letter-spacing: ${role.letterSpacing};`,
      role.color ? `  color: ${role.color};` : null,
      `}`,
    ]
      .filter(Boolean)
      .join('\n');

  return [
    `/* --- font set: ${set.name} --- */`,
    `/* ${set.description} */`,
    ``,
    rule('.slide', set.roles.base),
    ``,
    rule('.role-title', set.roles.title),
    ``,
    rule('.role-heading', set.roles.heading),
    ``,
    rule('.role-body', set.roles.body),
    ``,
    rule('.role-caption', set.roles.caption),
    ``,
    rule('.role-code', set.roles.code),
    ``,
  ].join('\n');
}

/** Marks the generated block so it can be replaced rather than duplicated. */
export const FONT_BLOCK_START = '/* >>> slide-editor font set (generated) */';
export const FONT_BLOCK_END = '/* <<< end font set */';

/**
 * Replace any previously generated font block, leaving the rest of the user's
 * stylesheet untouched. Applying a second set must not stack on the first.
 */
export function withFontBlock(css: string, block: string): string {
  const wrapped = `${FONT_BLOCK_START}\n${block}${FONT_BLOCK_END}\n`;
  const start = css.indexOf(FONT_BLOCK_START);
  const end = css.indexOf(FONT_BLOCK_END);
  if (start !== -1 && end > start) {
    return css.slice(0, start) + wrapped + css.slice(end + FONT_BLOCK_END.length + 1);
  }
  return `${wrapped}\n${css}`;
}
