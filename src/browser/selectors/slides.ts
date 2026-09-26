/** "Slides to video" import dialogs (File > Slides to video), verified 2026-09-23. */
export const SLIDES_LABELS = {
  /** Step 1 after the Drive picker: choose slides and whether Gemini adds narration. */
  selectSlides: 'Select slides',
  slideCheckbox: /^Slide (\d+)$/,
  aiSwitch: /^Include AI voiceover, script, background music and animation/,
  /** Step 2 (only with the AI switch on): edit the generated script, pick narration. */
  customize: 'Edit script and customize video',
  narration: 'Narration',
  narrationOptions: {
    voiceover: 'Voiceover only',
    avatar: 'AI avatar and voiceover',
  },
  /** Primary button of either step ("Next", "Create the draft video", "Import", …). */
  proceed: /^(Next|Import|Insert|Convert|Create|Done)\b/,
} as const;

export type SlidesNarration = keyof typeof SLIDES_LABELS.narrationOptions;
