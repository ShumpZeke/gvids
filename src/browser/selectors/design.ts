/**
 * Labels of the editor's design side panels (Transition, Animation, Format options)
 * and the Find and replace dialog. Observed on 2026-09-24 with hl=en.
 */
export const TRANSITION_TYPES = [
  'none',
  'dissolve',
  'fade',
  'push',
  'slide',
  'scale',
  'spin',
  'flicker',
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** Object enter/exit animations ("Enter & Exit" tab). */
export const OBJECT_ANIMATIONS = [
  'none',
  'typewriter',
  'fade',
  'slide',
  'rise',
  'scale',
  'spin',
  'breathe',
  'elastic slide',
  'toaster',
  'pop',
  'stomp',
  'twist',
  'shake',
  'flicker',
] as const;

/** Object loop animations ("Loop" tab). */
export const LOOP_ANIMATIONS = [
  'none',
  'fade',
  'flicker',
  'hover',
  'pulse',
  'shake',
  'spin',
  'breathe',
  'bounce',
  'wiggle',
] as const;

/** Whole-scene animations ("Scene" tab): moods and simple ones. */
export const SCENE_ANIMATIONS = [
  'none',
  'classic',
  'playful',
  'soft',
  'rhythmic',
  'bold',
  'festive',
  'fade',
  'slide',
  'rise',
  'scale',
  'elastic slide',
  'toaster',
  'pop',
  'stomp',
] as const;

export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export const ANIMATED_BY = ['whole', 'paragraph', 'word', 'character'] as const;

export const DESIGN_LABELS = {
  transitionButton: /^Transition\b/,
  animationButton: /^Animation\b/,
  transitionPanel: /^Transition$/,
  animationPanel: /^Animation$/,
  formatPanel: /^Format options$/,
  close: /^Close$/,
  typeGroup: /^Type$/,
  directionGroup: /^Direction$/,
  animatedByGroup: /^Animated by$/,
  duration: /duration, measured in seconds/i,
  tabs: { scene: /^Scene$/, object: /^Object$/, enterExit: /^Enter & Exit$/, loop: /^Loop$/ },
  format: {
    sizeSection: /^Size & Rotation$/,
    positionSection: /^Position$/,
    altTextSection: /^Alt Text$/,
    width: /^Width, measured in pixels/,
    height: /^Height, measured in pixels/,
    angle: /^Angle, measured in degrees/,
    x: /^X position/,
    y: /^Y position/,
    lockAspect: /^Lock aspect ratio$/,
    shadow: /^Toggle shadow$/,
    flipH: /^Flip horizontally$/,
    flipV: /^Flip vertically$/,
  },
  findReplace: {
    dialog: /^Find and replace$/,
    find: /^Find$/,
    replaceWith: /^Replace with$/,
    matchCase: /^Match case$/,
    regex: /^Use regular expressions/,
    replaceAll: /^Replace all$/,
    close: /^Close$/,
  },
} as const;
