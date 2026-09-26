import { describe, expect, it } from 'vitest';
import {
  extractVidIdFromEditorUrl,
  isGoogleSignInUrl,
  isVidsEditorUrl,
  isVidsHomeUrl,
  parseFolderId,
  parsePresentationId,
  parseResource,
  parseVidId,
  vidEditUrl,
  vidsCreateUrl,
  vidsHomeUrl,
} from '../../src/vids/urls.js';

const ID = '1X98GK2K5T5VQzUZKri6A-bctoB03n6r_6ccVD7PDmMU';

describe('parseResource', () => {
  it('accepts a bare ID', () => {
    expect(parseResource(ID)).toMatchObject({ id: ID, kind: 'unknown' });
  });

  it.each([
    [`https://docs.google.com/videos/d/${ID}/edit`, 'vid'],
    [`https://docs.google.com/videos/d/${ID}/edit?scene=id.p#scene=id.p`, 'vid'],
    [`https://docs.google.com/videos/u/1/d/${ID}/edit?usp=sharing`, 'vid'],
    [`docs.google.com/videos/d/${ID}`, 'vid'],
    [`https://drive.google.com/file/d/${ID}/view`, 'file'],
    [`https://drive.google.com/open?id=${ID}`, 'unknown'],
    [`https://drive.google.com/drive/folders/${ID}`, 'folder'],
    [`https://drive.google.com/drive/u/0/folders/${ID}`, 'folder'],
    [`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`, 'presentation'],
    [`https://docs.google.com/document/d/${ID}/edit`, 'document'],
  ])('extracts the ID from %s', (url, kind) => {
    expect(parseResource(url)).toMatchObject({ id: ID, kind });
  });

  it('captures resource keys', () => {
    expect(parseResource(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-abc`).resourceKey).toBe(
      '0-abc',
    );
  });

  it('rejects non-Google URLs and garbage', () => {
    expect(() => parseResource('https://example.com/videos/d/abc')).toThrow(/Not a Google URL/);
    expect(() => parseResource('')).toThrow(/empty/);
    expect(() => parseResource('not an id!')).toThrow();
    expect(() => parseResource('https://docs.google.com/videos/')).toThrow(/Could not find a file ID/);
  });
});

describe('typed parsers', () => {
  it('parseVidId rejects folder and presentation URLs', () => {
    expect(() => parseVidId(`https://drive.google.com/drive/folders/${ID}`)).toThrow(/folder/);
    expect(() => parseVidId(`https://docs.google.com/presentation/d/${ID}/edit`)).toThrow(/presentation/);
    expect(parseVidId(`https://drive.google.com/file/d/${ID}/view`)).toBe(ID);
  });

  it('parseFolderId accepts root', () => {
    expect(parseFolderId('root')).toBe('root');
    expect(() => parseFolderId(`https://docs.google.com/videos/d/${ID}/edit`)).toThrow(/folder/);
  });

  it('parsePresentationId rejects videos', () => {
    expect(parsePresentationId(`https://docs.google.com/presentation/d/${ID}/edit`)).toBe(ID);
    expect(() => parsePresentationId(`https://docs.google.com/videos/d/${ID}/edit`)).toThrow();
  });
});

describe('URL builders and classifiers', () => {
  it('builds editor URLs with hl and authuser', () => {
    expect(vidEditUrl(ID)).toBe(`https://docs.google.com/videos/d/${ID}/edit`);
    expect(vidEditUrl(ID, { hl: 'en', authuser: 1 })).toBe(
      `https://docs.google.com/videos/d/${ID}/edit?hl=en&authuser=1`,
    );
    expect(vidEditUrl(ID, { authuser: 0 })).not.toContain('authuser');
    expect(vidsHomeUrl({ hl: 'en' })).toBe('https://docs.google.com/videos/?hl=en');
    expect(vidsCreateUrl()).toBe('https://docs.google.com/videos/create');
  });

  it('classifies URLs', () => {
    expect(isVidsEditorUrl(`https://docs.google.com/videos/d/${ID}/edit`)).toBe(true);
    expect(isVidsEditorUrl('https://docs.google.com/videos/')).toBe(false);
    expect(isVidsHomeUrl('https://docs.google.com/videos/?hl=en')).toBe(true);
    expect(isVidsHomeUrl('https://docs.google.com/videos/u/0/')).toBe(true);
    expect(isGoogleSignInUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true);
    expect(extractVidIdFromEditorUrl(`https://docs.google.com/videos/u/0/d/${ID}/edit?hl=en`)).toBe(ID);
  });
});
