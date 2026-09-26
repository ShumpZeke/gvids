/**
 * "Help me create" storyboard flow (File > Storyboard), verified 2026-09-22:
 *   prompt → Next → "Setting the scene…" → "Edit the outline" → Next →
 *   "Select a design to start with" → "Create the draft video" → progress → editor.
 */
export const STORYBOARD_LABELS = {
  dialog: 'Getting started',
  prompt: 'Enter a prompt here',
  next: 'Next',
  tryAgain: 'Try again',
  outlineHeading: 'Edit the outline',
  addScene: 'Add scene',
  removeScene: 'Remove scene',
  designHeading: 'Select a design to start with',
  designGroup: 'Select a design to start with',
  createDraft: 'Create the draft video',
  /** Progress bar label while the draft video is generated. */
  creatingProgress: 'Creating video',
  outlineProgress: /Setting the scene/i,
  cancel: 'Cancel',
  maxPromptLength: 5000,
  maxTopicLength: 255,
} as const;
