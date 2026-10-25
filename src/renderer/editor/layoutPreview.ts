import type { LayoutMaster, Slide, SlideElement } from '@shared/deck.js';
import { defaultLayoutMasters, type FixedLayout } from '@shared/layoutMasters.js';
import type { ThemePreset } from '@shared/themes.js';
import { renderSlide } from '../player/render.js';

/**
 * Sample slides for the design surfaces: the three fixed masters dressed in a
 * theme, drawn through the player so they look exactly like real slides.
 * Shared by the Design tab's master strip, the Props tab's layout picker and
 * the layout editor, which is why this lives apart from either panel.
 */

export const FIXED_LAYOUTS: FixedLayout[] = ['freeform', 'standard', 'title'];

export const LAYOUT_LABELS_BY_ID: Record<FixedLayout, string> = {
  freeform: 'Freeform',
  standard: 'Title + Body',
  title: 'Title',
};

export function previewSlide(layout: FixedLayout, master: LayoutMaster): Slide {
  const elements = revealPlaceholders(structuredClone(master.elements));
  for (const element of elements) {
    if (element.type !== 'text') continue;
    if (element.layoutPlaceholder === 'title') element.html = 'The big idea';
    else if (element.layoutPlaceholder === 'body') {
      element.html = 'Readable body copy for the story.';
    }
  }
  if (layout === 'freeform') {
    elements.push({
      id: 'preview-freeform-title', type: 'text', x: 160, y: 150, w: 1600, h: 180,
      rot: 0, z: 50, opacity: 1, class: ['role-title'], style: {},
      html: 'The big idea', align: 'left', valign: 'middle', autoFit: true,
    }, {
      id: 'preview-freeform-body', type: 'text', x: 160, y: 390, w: 1200, h: 260,
      rot: 0, z: 51, opacity: 1, class: ['role-body'], style: {},
      html: 'Readable body copy for the story.',
      align: 'left', valign: 'top', autoFit: true,
    }, {
      id: 'preview-freeform-caption', type: 'text', x: 160, y: 880, w: 1200, h: 70,
      rot: 0, z: 52, opacity: 1, class: ['role-caption'], style: {},
      html: 'Supporting detail', align: 'left', valign: 'middle', autoFit: true,
    });
  } else if (layout === 'standard') {
    elements.push({
      id: 'preview-standard-caption', type: 'text', x: 120, y: 970, w: 1680, h: 50,
      rot: 0, z: 52, opacity: 1, class: ['role-caption'], style: {},
      html: 'Supporting detail', align: 'left', valign: 'middle', autoFit: true,
    });
  }
  return {
    id: `preview-${layout}`,
    name: LAYOUT_LABELS_BY_ID[layout],
    background: structuredClone(master.background),
    notes: '',
    layout: 'freeform',
    elements,
    timeline: [],
  };
}

const PREVIEW_ROLES = ['title', 'heading', 'body', 'caption', 'code'] as const;

/**
 * Paint a theme onto a preview clone that renders outside any theme stylesheet.
 *
 * Element styles are CSS declarations handed straight to `setProperty`, so the
 * keys are kebab-case. The size belongs here too: a type scale is most of what
 * distinguishes one theme from the next.
 */
export function applyThemeInline(slide: Slide, theme: ThemePreset): void {
  if (!slide.background.color && !slide.background.image) {
    slide.background = { color: theme.colors.background, image: null };
  }
  for (const element of slide.elements) {
    if (element.type !== 'text') continue;
    const role = PREVIEW_ROLES.find((name) => element.class.includes(`role-${name}`)) ?? 'base';
    const font = theme.fonts[role];
    element.style = {
      ...element.style,
      'font-family': font.family,
      'font-size': `${font.size}px`,
      'font-weight': String(font.weight),
      'letter-spacing': font.letterSpacing,
      'line-height': String(font.lineHeight),
      color: font.color ?? (role === 'caption' ? theme.colors.muted : theme.colors.text),
    };
  }
}

/**
 * Placeholder copy is prompt text that `type.css` hides everywhere outside an
 * editing surface; a design surface rendering masters through the player has
 * to opt out or it draws empty slides.
 */
export function revealPlaceholders<T extends SlideElement>(elements: T[]): T[] {
  for (const element of elements) {
    element.class = element.class.filter((name) => name !== 'placeholder');
  }
  return elements;
}

/**
 * A 16:9 frame holding a master rendered in `theme`, scaled to the frame's
 * width. Returns the frame and the observer keeping it scaled.
 */
export function masterTile(
  layout: FixedLayout,
  masters: NonNullable<import('@shared/deck.js').Deck['layoutMasters']> | null | undefined,
  theme: ThemePreset | null,
  options: { caption?: boolean } = {},
): { frame: HTMLElement; observer: ResizeObserver | null } {
  const frame = document.createElement('span');
  frame.className = 'design-preview-frame';
  const master = (masters ?? defaultLayoutMasters())[layout];
  const slide = previewSlide(layout, master);
  if (options.caption === false) {
    slide.elements = slide.elements.filter((element) => !element.id.endsWith('-caption'));
  }
  if (theme) applyThemeInline(slide, theme);
  frame.appendChild(renderSlide(slide, {
    resolveSrc: (src) => window.api?.assetUrl?.(src) ?? src,
    mediaPreload: 'metadata',
  }));
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => {
      frame.style.setProperty('--design-preview-scale', String(entry.contentRect.width / 1920));
    });
    observer.observe(frame);
  }
  return { frame, observer };
}
