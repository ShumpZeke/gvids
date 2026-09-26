/** AI side panels (AI video clip, voiceover, avatar), verified 2026-09-22. */
export const AI_VIDEO_LABELS = {
  panel: 'AI video clip',
  tabs: { create: 'Create', edit: 'Edit', animate: 'Animate' },
  prompts: {
    create: /^Describe your video/,
    /** Renamed by 2026-09-24 ("Describe changes you want to make"). */
    edit: /^(Add your video, then describe|Describe changes you want to make)/,
    animate: /^(Add your image, then describe|Describe (how|the motion|changes))/,
  },
  ingredients: 'Ingredients',
  avatar: 'Avatar',
  addVideo: /^Add video/,
  addImage: /^Add image/,
  generate: 'Generate',
  modelMenu: 'Model',
  aspectMenu: 'Aspect ratio',
  expand: 'Expand',
  /** A finished clip in the side sheet offers Insert / Extend / Edit / Recreate / Remove. */
  resultInsert: /^(Insert|Insert video|Add to video|Add to scene)$/,
  /** Clicking it previews the clip on the canvas with these choices (verified 2026-09-23). */
  preview: {
    newScene: 'Insert in new scene',
    currentScene: 'Insert in current scene',
    more: 'More options',
  },
} as const;

/** Where a generated AI clip goes: a new scene (the Vids default), the selected scene, or nowhere. */
export type AiInsertTarget = 'new-scene' | 'current-scene' | 'none';

export const VOICEOVER_LABELS = {
  panel: 'AI voiceover',
  tabs: { current: 'Current scene', all: 'All scenes' },
  scripts: 'Scripts',
  /** Placeholder drawn (as ordinary SVG text) in an empty script box. */
  scriptPlaceholder: /^Enter a script, or type '\[' to view audio tags$/,
  previousScript: 'Previous script',
  nextScript: 'Next script',
  changeVoice: 'Change the voice',
  voiceDialog: 'Select a voice',
  /** "Select" in the voiceover panel's dialog, "Use this voiceover" in Docs to video. */
  select: /^(Select|Use this voiceover)$/,
  insert: 'Insert voiceover',
  update: 'Update voiceover',
  applyAudioTags: /^Gemini will analyze your script/,
  /** "3 out of 37 voices. Knox voice that is smooth and low pitch. Press enter to play." */
  voiceItem: /^(\d+) out of (\d+) voices\. (.+?) voice that is (.+?)\. Press/,
} as const;

export const AVATAR_LABELS = {
  panel: 'AI avatar',
  scripts: 'Scripts',
  changeAvatar: 'Change the avatar',
  dialogHeading: 'Avatars',
  select: 'Select',
  preview: 'Preview',
  /** "Finley: Soft, higher pitch (preset)" / "Olivia: Lively, higher pitch (Classic, preset)" */
  avatarRadio: /^(.+?): (.+?) \((.+)\)$/,
  /** Older panels insert directly ("Insert avatar"); since 2026-09-24 "Preview" first shows a clip, then "Generate". */
  insert: /^(Insert|Generate)( avatar)?$/,
} as const;

export const TEXT_LABELS = {
  panel: 'Text',
  title: 'Add a title',
  subtitle: 'Add a subtitle',
  body: 'Add body text',
} as const;

export const PICKER_LABELS = {
  frame: 'iframe[src*="/picker/"]',
  search: 'Search in Drive or paste URL',
  /** Left-nav entry (an option) that shows the "Browse" button for local files. */
  uploadPane: 'Upload',
  browse: 'Browse',
  /** Button that reveals the search box in the "Drive & Photos" picker. */
  openSearch: 'Search',
  /** Left-nav options of the "Open a file" picker (not search results). */
  navOption: /^(Google Drive|Google Photos|Photos|Upload)$/,
  /** Confirm button, e.g. "Select 1 item" (text "Select"); Docs to video says "Next 1 item". */
  select: /^(Select|Insert|Open|Next)\b/,
  close: /^Close picker/,
} as const;
