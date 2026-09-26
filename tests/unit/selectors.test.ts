import { describe, expect, it } from 'vitest';
import { findTemplateName } from '../../src/browser/pages/start-dialog.js';
import { AI_VIDEO_LABELS, PICKER_LABELS, VOICEOVER_LABELS } from '../../src/browser/selectors/ai.js';
import { EDITOR_LABELS } from '../../src/browser/selectors/editor.js';
import { SLIDES_LABELS } from '../../src/browser/selectors/slides.js';

// Labels below were copied from the live Vids UI (2026-09-23); these tests pin
// the matching rules so a refactor cannot silently loosen or break them.

describe('template name matching', () => {
  const names = ['Personal celebration', 'Tutorial', 'How-to video', 'Q&A session'];

  it('matches display names case-insensitively', () => {
    expect(findTemplateName(names, 'tutorial')).toBe('Tutorial');
    expect(findTemplateName(names, 'PERSONAL CELEBRATION')).toBe('Personal celebration');
  });

  it('matches `gvids template list` slugs', () => {
    expect(findTemplateName(names, 'personal-celebration')).toBe('Personal celebration');
    expect(findTemplateName(names, 'how-to-video')).toBe('How-to video');
    expect(findTemplateName(names, 'q-and-a-session')).toBe('Q&A session');
  });

  it('returns undefined for unknown templates', () => {
    expect(findTemplateName(names, 'wedding')).toBeUndefined();
  });
});

describe('editor labels', () => {
  it('recognizes the download refusal dialog with either apostrophe', () => {
    expect(EDITOR_LABELS.downloadBlocked.test("Can't download GIF")).toBe(true);
    expect(EDITOR_LABELS.downloadBlocked.test('Can’t download GIF')).toBe(true);
    expect(EDITOR_LABELS.downloadBlocked.test('Download started')).toBe(false);
  });

  it('finds File > Move to trash but not other items', () => {
    expect(EDITOR_LABELS.menuItems.moveToTrash.test('Move to trash')).toBe(true);
    expect(EDITOR_LABELS.menuItems.moveToTrash.test('Move')).toBe(false);
  });
});

describe('voiceover script placeholder', () => {
  it('matches only the empty-box placeholder', () => {
    expect(VOICEOVER_LABELS.scriptPlaceholder.test("Enter a script, or type '[' to view audio tags")).toBe(
      true,
    );
    expect(VOICEOVER_LABELS.scriptPlaceholder.test('Enter a script for the intro')).toBe(false);
  });
});

describe('AI video labels', () => {
  it('finds the finished clip’s Insert button but not the preview choices', () => {
    expect(AI_VIDEO_LABELS.resultInsert.test('Insert')).toBe(true);
    expect(AI_VIDEO_LABELS.resultInsert.test('Insert video')).toBe(true);
    expect(AI_VIDEO_LABELS.resultInsert.test('Insert in new scene')).toBe(false);
    expect(AI_VIDEO_LABELS.resultInsert.test('Insert text')).toBe(false);
  });
});

describe('Drive picker labels', () => {
  it('accepts the confirm button however many items are selected', () => {
    expect(PICKER_LABELS.select.test('Select 1 item')).toBe(true);
    expect(PICKER_LABELS.select.test('Select')).toBe(true);
    expect(PICKER_LABELS.select.test('Insert')).toBe(true);
    expect(PICKER_LABELS.select.test('Selected')).toBe(false);
  });

  it('tells left-nav entries from search results', () => {
    expect(PICKER_LABELS.navOption.test('Upload')).toBe(true);
    expect(PICKER_LABELS.navOption.test('Google Drive')).toBe(true);
    expect(PICKER_LABELS.navOption.test('gvids slides test Google Slides')).toBe(false);
  });
});

describe('Slides import labels', () => {
  it('matches the real slide checkboxes, not the loading placeholders', () => {
    expect(SLIDES_LABELS.slideCheckbox.test('Slide 12')).toBe(true);
    expect(SLIDES_LABELS.slideCheckbox.test('Disabled while loading your slides')).toBe(false);
  });

  it('proceeds through both dialog steps', () => {
    expect(SLIDES_LABELS.proceed.test('Next')).toBe(true);
    expect(SLIDES_LABELS.proceed.test('Create the draft video')).toBe(true);
    expect(SLIDES_LABELS.proceed.test('Close dialog')).toBe(false);
    expect(SLIDES_LABELS.proceed.test('Back')).toBe(false);
  });

  it('recognizes the AI switch', () => {
    expect(SLIDES_LABELS.aiSwitch.test('Include AI voiceover, script, background music and animation')).toBe(
      true,
    );
  });
});
