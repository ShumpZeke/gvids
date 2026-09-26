/**
 * Accessible names in the Google Vids editor (English UI, hl=en).
 * Verified against the live editor on 2026-09-22.
 */
export const EDITOR_LABELS = {
  menubar: 'menubar',
  toolbars: {
    main: 'Main',
    insertion: 'Insertion',
    modeAndView: 'Mode and view',
  },
  showMenus: /^Show the menus/,
  hideMenus: /^Hide the menus/,
  menuSearch: 'Menus',
  newScene: /^New scene/,
  /** Timeline scene thumbnails: "Scene 3 of 22". */
  sceneButton: /^Scene \d+ of \d+$/,
  closeSideSheet: 'Close side sheet',
  topMenus: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    insert: 'Insert',
    format: 'Format',
    scene: 'Scene',
    arrange: 'Arrange',
    tools: 'Tools',
    help: 'Help',
  },
  menuItems: {
    videoSize: /^Video size/,
    download: /^Download\b/,
    downloadMp4: /^MP4 video/,
    downloadGif: /^GIF animation/,
    exportToDrive: /^Export to Drive/,
    storyboard: /^Storyboard/,
    slidesToVideo: /^Slides to video/,
    docsToVideo: /^Docs to video/,
    makeCopy: /^Make a copy/,
    entireVideo: /^Entire video/,
    /** "Move m" (the menu item's name ends with its one-character mnemonic); never "Move to trash t". */
    move: /^Move(?: \S)?$/,
    versionHistory: /^Version history/,
    nameCurrentVersion: /^Name current version/,
    findAndReplace: /^Find and replace/,
    moveToTrash: /^Move to trash/,
    upload: /^Upload\b/,
    driveAndPhotos: /^Drive & Photos/,
    duplicateScene: /^Duplicate scenes?\b/,
    deleteScene: /^Delete scenes?\b/,
    moveScene: /^Move scenes?(?! (left|right|to))/,
    moveSceneLeft: /^Move scenes? left/,
    moveSceneRight: /^Move scenes? right/,
    moveSceneToBeginning: /^Move scenes? to beginning/,
    moveSceneToEnd: /^Move scenes? to end/,
    background: /^Background\b/,
    delete: /^Delete$/,
  },
  videoSize: {
    combobox: 'Page or video size select',
    apply: 'Apply',
    cancel: 'Cancel',
    options: {
      landscape: /^Landscape/,
      portrait: /^Portrait/,
      square: /^Square/,
    },
  },
  color: {
    addCustom: 'Add a custom color',
    hex: 'Hex color',
    ok: 'OK',
  },
  insertion: {
    aiVideo: 'Generate an AI video clip',
    avatar: 'Generate an avatar',
    voiceover: 'Generate a voiceover',
    music: 'Generate music',
    image: 'Generate an image',
    record: 'Record',
    uploads: 'Drive and Photos',
    stock: 'Stock and web',
    captions: 'Captions',
    text: 'Insert text',
    templates: 'Insert from templates',
    shapes: 'Insert shapes and lines',
  },
  /**
   * Heading of the alert dialog Vids shows instead of starting a download, e.g.
   * "Can't download GIF" (GIFs are limited to 30-second videos).
   */
  downloadBlocked: /can['’]?t download|cannot download|unable to download|couldn['’]?t download/i,
  /**
   * Alert dialog shown over a trashed video ("File is in trash", or "File moved
   * to trash" right after File > Move to trash); its button restores the file.
   */
  trash: {
    restore: 'Take out of trash',
  },
  /** Popups that block input and are safe to dismiss (never feedback buttons). */
  dismissible: {
    gotIt: /^Got it$/,
    close: /^Close$/,
  },
} as const;

export type InsertionTool = keyof typeof EDITOR_LABELS.insertion;

export const EDITOR_CSS = {
  /** Title field in the menu bar (only visible when the menus are shown). */
  titleInput: 'input.docs-title-input',
  saveIndicator: '.docs-save-indicator-caption, .docs-save-indicator',
  /** Each scene canvas is an <svg> under .pages; the visible one is the current scene. */
  canvasSvg: '.pages > svg',
  sceneHandle: '.appsFlixTimelineSceneHandleBackground',
} as const;

/** Getting started dialog shown for brand-new videos. */
export const START_LABELS = {
  dialog: 'Getting started',
  format: {
    landscape: 'Create a landscape video',
    portrait: 'Create a portrait video',
    square: 'Create a square video',
  },
  /** Creation options as displayed (the set varies by format and account). */
  options: {
    aiVideos: 'Create AI videos',
    editVideos: 'Edit videos',
    personalAvatar: 'Personal avatar',
    aiAvatar: 'AI avatar',
    docsToVideo: 'Docs to video',
    slidesToVideo: 'Slides to video',
    record: 'Record',
    upload: 'Upload',
    templates: 'Templates',
    blank: 'Blank vid',
  },
  templatesListbox: 'Start with a template',
  uploadBrowseComputer: 'Browse computer',
} as const;
