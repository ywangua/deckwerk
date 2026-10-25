/** Persisted language ids and UI labels. Keep parser imports out of the deck schema. */
export const CODE_LANGUAGES = ['python', 'javascript', 'c', 'cpp', 'csharp', 'java', 'matlab', 'julia', 'latex', 'typst', 'markdown'] as const;
export type CodeLanguage = typeof CODE_LANGUAGES[number];
export const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: 'Python', javascript: 'JavaScript', c: 'C', cpp: 'C++',
  csharp: 'C#', java: 'Java', matlab: 'MATLAB', julia: 'Julia',
  latex: 'LaTeX', typst: 'Typst', markdown: 'Markdown',
};
export const CODE_LANGUAGE_OPTIONS = CODE_LANGUAGES.map((language) => CODE_LANGUAGE_LABELS[language]);

export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === 'string' && CODE_LANGUAGES.some((language) => language === value);
}

export function codeLanguageFromLabel(label: string): CodeLanguage {
  return CODE_LANGUAGES.find((language) => CODE_LANGUAGE_LABELS[language] === label) ?? 'python';
}
