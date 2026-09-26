/** "Docs to video" dialogs (File > Docs to video, or the new-video dialog), verified 2026-09-25. */
export const DOCS_LABELS = {
  /** After the Drive picker ("Next 1 item"), Gemini drafts one script per scene here. */
  review: 'Review and edit your script',
  /** One textarea per drafted scene, numbered from 0. */
  sceneScript: /^edit scene (\d+)$/,
  /** The script boxes' maxlength. */
  maxSceneChars: 800,
  voiceGroup: 'AI voiceover',
  changeVoice: 'Select a voiceover style',
  create: 'Create',
  close: 'Close dialog',
  /** Closing the review asks "Discard and close?" (Cancel / Continue). */
  discard: 'Discard and close?',
  discardConfirm: 'Continue',
  /** Error text shown instead of a draft (while drafting the dialog says "Mapping narrative structure..."). */
  failure: /something went wrong|couldn['’]t (generate|create|read|access|open)|unable to (generate|create|read)/i,
} as const;
