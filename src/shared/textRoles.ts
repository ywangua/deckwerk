/** Semantic text roles shared by themes, the editor and agent tools. */
export const TEXT_ROLES = ['title', 'heading', 'body', 'caption', 'code', 'base'] as const;
export type TextRole = typeof TEXT_ROLES[number];
export const TEXT_ROLE_CLASS = /^role-(title|heading|body|caption|code|base)$/;
export const CODE_FONT_FAMILY = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

interface CodeFont {
  family: string;
  size: number;
  weight: number;
  lineHeight: number;
  letterSpacing: string;
  color?: string;
}

export function codeFont(caption: { size: number; lineHeight: number }): CodeFont {
  return { family: CODE_FONT_FAMILY, size: caption.size, weight: 400,
    lineHeight: caption.lineHeight, letterSpacing: '0' };
}
