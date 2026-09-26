import path from 'node:path';
import type { Locator, Page } from 'playwright';
import type { GvidsConfig } from '../../config/config.js';
import {
  DownloadError,
  FeatureUnavailableError,
  GenerationFailedError,
  GenerationTimeoutError,
  NotFoundError,
  UsageError,
  withContext,
} from '../../errors/errors.js';
import type { ShareRole, ShareTarget } from '../../google/permissions.js';
import type { VidPermission } from '../../vids/types.js';
import { acquireVideoLock } from '../coordination.js';
import {
  copyInEditor,
  exportToDriveInEditor,
  moveInEditor,
  nameVersionInEditor,
} from '../pages/file-dialogs.js';
import { SharePanel, shareInDialog, unshareInDialog } from '../pages/sharing.js';
import {
  animate,
  findReplace,
  getObjectFormat,
  setObjectFormat,
  setTransition,
  type AnimationRequest,
  type ObjectFormat,
} from '../pages/design.js';
import type { TransitionType } from '../selectors/design.js';
import { insertStock, searchStock, type StockResult, type StockType } from '../pages/stock.js';
import { generateImage, generateMusic, type ImageAspect, type ImageStyle } from '../pages/generate.js';
import { addCaptions, listCaptionStyles, removeCaptions, type CaptionStyle } from '../pages/captions.js';
import { fillScene, replaceMedia, setSound, trimMedia } from '../pages/media-tools.js';
import { toGvidsError } from '../../errors/map.js';
import { pathExists } from '../../utils/fs.js';
import type { Logger } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';
import type { SceneInfo, SceneObject, TemplateInfo, TimelineClip, VideoFormat } from '../../vids/types.js';
import { slugify } from '../../vids/types.js';
import { extractVidIdFromEditorUrl, vidEditUrl } from '../../vids/urls.js';
import { VidsEditor, type EditorOptions } from '../pages/editor-page.js';
import {
  AiVideoPanel,
  applyPanelTemplate,
  AvatarPanel,
  chooseVoice,
  listPanelTemplates,
  pickDriveFileByUrl,
  removeVoiceovers,
  voiceDialog,
  VoiceoverPanel,
  type AiVideoMode,
  type AvatarInfo,
  type VoiceInfo,
} from '../pages/panels.js';
import { VidsHome, type HomeVideo } from '../pages/home-page.js';
import { StartDialog } from '../pages/start-dialog.js';
import { StoryboardFlow, type DesignOption } from '../pages/storyboard.js';
import { EDITOR_LABELS, START_LABELS } from '../selectors/editor.js';
import { AI_VIDEO_LABELS, type AiInsertTarget } from '../selectors/ai.js';
import { DOCS_LABELS } from '../selectors/docs.js';
import { SLIDES_LABELS, type SlidesNarration } from '../selectors/slides.js';
import type { BrowserSession } from '../session.js';
import { armed, detectAvailabilityProblem, uiStep, type UiContext } from '../ui.js';

export interface VideoSummary {
  id: string;
  url: string;
  title: string;
  scenes: number;
}

export type CreateMode =
  | { kind: 'blank' }
  | { kind: 'template'; template: string; scenes?: number[] }
  | { kind: 'upload'; file: string }
  | ({ kind: 'slides'; presentationId: string } & Omit<SlidesImportOptions, 'timeoutMs'>)
  | ({ kind: 'docs'; documentId: string } & Omit<DocsImportOptions, 'timeoutMs' | 'scriptOnly'>);

export interface DocsImportOptions {
  timeoutMs: number;
  /** Replaces Gemini's scene scripts in order; later scenes keep Gemini's text. */
  script?: string[];
  /** AI voiceover voice (default: the one Vids suggests). */
  voice?: string;
  /** Stop after the drafted script (nothing is added). */
  scriptOnly?: boolean;
}

export interface DocsImportResult {
  /** One narration script per scene, as it was when Create was pressed (or the draft). */
  script: string[];
  voice?: string;
  created: boolean;
  scenesBefore: number;
  scenesAfter: number;
}

export interface SlidesImportOptions {
  timeoutMs: number;
  /** Gemini script + AI narration, music and animation (the Vids default). */
  ai?: boolean;
  /** 1-based slide numbers to import (default: all). */
  slides?: number[];
  narration?: SlidesNarration;
}

export interface SlidesImportResult {
  scenesBefore: number;
  scenesAfter: number;
  slides: number;
  ai: boolean;
}

export interface StoryboardOptions {
  prompt: string;
  /** Replace Gemini's outline with these scene topics before creating the draft. */
  outline?: string[];
  /** 1-based design choice (default 1). */
  design?: number;
  /** Drive file names to @-mention in the prompt (experimental). */
  contextFiles?: string[];
  /** Stop after the outline (do not create the draft). */
  outlineOnly?: boolean;
  /** Ask Gemini for a different outline this many times ("Try again"). */
  retryOutline?: number;
  timeoutMs: number;
}

export interface StoryboardResult {
  outline: string[];
  designs?: DesignOption[];
  design?: number;
  scenesBefore: number;
  scenesAfter?: number;
  created: boolean;
}

async function assertFile(file: string): Promise<string> {
  const resolved = path.resolve(file);
  if (!(await pathExists(resolved))) throw new UsageError(`File not found: ${resolved}`);
  return resolved;
}

export interface AutomationOptions {
  /** What this command is doing; shown to commands waiting for the same video. */
  label?: string;
  /** How long to wait while another command works on the same video (default 10 minutes). */
  lockTimeoutMs?: number;
}

/**
 * High-level Google Vids editor operations over one browser session and one
 * tab. Commands, workflows and the MCP server all go through this class.
 */
export class VidsAutomation {
  private page: Page | undefined;
  private current: VidsEditor | undefined;
  /** Videos whose cross-process lock this session holds. */
  private readonly locked = new Set<string>();

  constructor(
    readonly session: BrowserSession,
    private readonly config: GvidsConfig,
    private readonly logger: Logger,
    private readonly options: AutomationOptions = {},
  ) {}

  /** Takes the video's lock for the rest of the session: commands on one video run one at a time. */
  private async lockVideo(id: string): Promise<void> {
    if (this.locked.has(id)) return;
    const release = await acquireVideoLock(this.session.paths, id, {
      label: this.options.label ?? 'gvids command',
      timeoutMs: this.options.lockTimeoutMs ?? 10 * 60_000,
      onWait: (holder) =>
        this.logger.warn(
          `Waited for another gvids command${holder ? ` (pid ${holder.pid}${holder.label ? `, ${holder.label}` : ''})` : ''} to finish with video ${id}.`,
        ),
    });
    this.locked.add(id);
    this.session.onClose(async () => {
      this.locked.delete(id);
      await release();
    });
  }

  private editorOptions(): EditorOptions {
    return {
      hl: this.config.browser.locale,
      authuser: this.config.browser.authuser,
      timeoutMs: this.config.browser.timeout,
      diagnostics: this.session.diagnostics,
      logger: this.logger,
    };
  }

  private async tab(): Promise<Page> {
    if (!this.page || this.page.isClosed()) this.page = await this.session.firstPage();
    return this.page;
  }

  /** Opens (or reuses) the editor for `id`. */
  async editor(id: string, open: { allowTrashed?: boolean } = {}): Promise<VidsEditor> {
    if (
      this.current &&
      !this.current.page.isClosed() &&
      extractVidIdFromEditorUrl(this.current.page.url()) === id
    ) {
      await this.current.dismissPopups();
      return this.current;
    }
    await this.lockVideo(id);
    // A tab left idle by an earlier command on the same video skips the editor load.
    const idle = await this.session.claimIdlePage((url) => extractVidIdFromEditorUrl(url) === id);
    if (idle) {
      this.logger.debug({ id }, 'reusing an idle editor tab');
      this.page = idle;
      const resumed = await VidsEditor.resume(idle, id, this.editorOptions(), open).catch((err: unknown) => {
        // A trashed video stays an error; anything else (a stuck dialog, a half-loaded tab) gets a fresh load.
        if (err instanceof NotFoundError) throw err;
        this.logger.debug({ err: String(err) }, 'idle tab unusable; reloading the editor');
        return undefined;
      });
      if (resumed) {
        this.current = resumed;
        return this.current;
      }
      this.current = await VidsEditor.open(idle, id, this.editorOptions(), open);
      return this.current;
    }
    const page = await this.tab();
    this.current = await VidsEditor.open(page, id, this.editorOptions(), open);
    return this.current;
  }

  async summary(editor: VidsEditor): Promise<VideoSummary> {
    return {
      id: editor.id,
      url: vidEditUrl(editor.id),
      title: await editor.title(),
      scenes: await editor.sceneCount(),
    };
  }

  /** Puts UI preferences back and waits for Drive to save. */
  async finish(): Promise<void> {
    if (!this.current || this.current.page.isClosed()) return;
    await this.current.restoreUi().catch(() => undefined);
    const saved = await this.current.waitForSaved(45_000).catch(() => false);
    if (!saved) this.logger.warn('Vids did not report "Saved to Drive" within 45s');
  }

  // ------------------------------------------------------------ home

  /** Recent videos (or search results for `query`) from the Vids home page. */
  async home(query: string | undefined, limit: number): Promise<HomeVideo[]> {
    const home = await VidsHome.open(await this.tab(), this.editorOptions(), query);
    return home.videos(limit);
  }

  /** What the editor can tell about a video without the Drive API. */
  async info(
    id: string,
  ): Promise<VideoSummary & { durationSeconds: number; format: string; formatLabel: string }> {
    const editor = await this.editor(id);
    const scenes = await editor.scenes();
    const size = await editor.canvasFormat();
    const durationSeconds =
      Math.round(scenes.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0) * 10) / 10;
    return {
      ...(await this.summary(editor)),
      durationSeconds,
      format: size.format,
      formatLabel: size.label,
    };
  }

  // ------------------------------------------------------------ create

  async create(options: { format: VideoFormat; mode: CreateMode; title?: string }): Promise<VideoSummary> {
    const page = await this.tab();
    const start = await StartDialog.createNew(page, this.editorOptions());
    const createdId = start.id;
    this.logger.info({ id: createdId }, 'created new Vids file');
    try {
      return await this.fillNew(start, options);
    } catch (err) {
      // The file exists in Drive from the moment the create page opened: say so, with a cleanup path.
      throw withContext(toGvidsError(err), {
        details: { createdVideo: { id: createdId, url: vidEditUrl(createdId) } },
        hint: [
          `A video was already started (${createdId}) before this step failed.`,
          `If nothing was added it is not saved to Drive; otherwise remove it with: gvids trash ${createdId} --yes`,
        ],
        next: [],
      });
    }
  }

  private async fillNew(
    start: StartDialog,
    options: { format: VideoFormat; mode: CreateMode; title?: string },
  ): Promise<VideoSummary> {
    const page = start.page;
    const formats = await start.formats();
    if (!formats.find((f) => f.format === options.format)?.selected) await start.setFormat(options.format);
    let editor: VidsEditor;
    switch (options.mode.kind) {
      case 'blank':
        editor = await start.blank();
        break;
      case 'template': {
        // The start dialog inserts one selected scene (or all); add the rest from the side panel.
        const [first, ...more] = options.mode.scenes ?? [];
        editor = await start.useTemplate(options.mode.template, first === undefined ? undefined : [first]);
        this.current = editor;
        if (more.length > 0) await applyPanelTemplate(editor, options.mode.template, undefined, more);
        break;
      }
      case 'upload':
        editor = await start.upload(await assertFile(options.mode.file));
        break;
      case 'slides': {
        // The start dialog's own "Slides to video" opens the same picker (and leaves no blank scene).
        await start.choose(START_LABELS.options.slidesToVideo);
        const { presentationId, ai, slides, narration } = options.mode;
        const timeoutMs = 10 * 60_000;
        const ui: UiContext = { page, diagnostics: this.session.diagnostics };
        const picked = await this.slidesDialogs(ui, presentationId, { timeoutMs, ai, slides, narration });
        await this.waitForImport('Slides import', page, timeoutMs, async () => true);
        editor = await VidsEditor.attach(page, this.editorOptions());
        const deadline = Date.now() + timeoutMs;
        while ((await editor.sceneCount()) < picked.slides && Date.now() < deadline) await sleep(1000);
        break;
      }
      case 'docs': {
        await start.choose(START_LABELS.options.docsToVideo);
        const { documentId, script, voice } = options.mode;
        const timeoutMs = 10 * 60_000;
        const ui: UiContext = { page, diagnostics: this.session.diagnostics };
        const draft = await this.docsDialogs(ui, documentId, {
          timeoutMs,
          ...(script ? { script } : {}),
          ...(voice ? { voice } : {}),
        });
        await this.waitForImport('Docs to video', page, timeoutMs, async () => true);
        editor = await VidsEditor.attach(page, this.editorOptions());
        await this.waitForSceneCount(editor, draft.script.length, timeoutMs);
        break;
      }
    }
    this.current = editor;
    if (options.title) await editor.rename(options.title);
    await editor.waitForSaved();
    return this.summary(editor);
  }

  // -------------------------------------------------------- storyboard

  async storyboard(id: string, options: StoryboardOptions): Promise<StoryboardResult> {
    const editor = await this.editor(id);
    const scenesBefore = await editor.sceneCount();
    const flow = new StoryboardFlow(editor);
    await flow.open();
    await flow.setPrompt(options.prompt);
    for (const name of options.contextFiles ?? []) await flow.mentionFile(name);
    let outline = await flow.generateOutline(options.timeoutMs);
    for (let i = 0; i < (options.retryOutline ?? 0); i++)
      outline = await flow.retryOutline(options.timeoutMs);
    if (options.outline && options.outline.length > 0) {
      await flow.setOutline(options.outline);
      outline = await flow.readOutline();
    }
    if (options.outlineOnly) {
      await flow.cancel();
      return { outline, scenesBefore, created: false };
    }
    const designs = await flow.acceptOutline();
    const design = options.design ?? 1;
    await flow.createDraft(design, options.timeoutMs);
    const scenesAfter = await editor.sceneCount();
    await editor.waitForSaved();
    return { outline, designs, design, scenesBefore, scenesAfter, created: true };
  }

  // ------------------------------------------------------------ scenes

  async scenes(id: string): Promise<SceneInfo[]> {
    return (await this.editor(id)).scenes();
  }

  async addScene(id: string, after?: number): Promise<{ index: number; scenes: number }> {
    const editor = await this.editor(id);
    const index = await editor.addScene(after);
    return { index, scenes: await editor.sceneCount() };
  }

  async duplicateScene(id: string, n: number): Promise<{ index: number; scenes: number }> {
    const editor = await this.editor(id);
    const index = await editor.duplicateScene(n);
    return { index, scenes: await editor.sceneCount() };
  }

  async deleteScene(id: string, n: number): Promise<{ deleted: number; scenes: number }> {
    const editor = await this.editor(id);
    await editor.deleteScene(n);
    return { deleted: n, scenes: await editor.sceneCount() };
  }

  async moveScene(id: string, from: number, to: number): Promise<{ from: number; to: number }> {
    const editor = await this.editor(id);
    await editor.moveScene(from, to);
    return { from, to };
  }

  async sceneBackground(id: string, n: number, color: string): Promise<{ scene: number; color: string }> {
    const editor = await this.editor(id);
    await editor.setSceneBackground(n, color);
    return { scene: n, color };
  }

  async sceneDuration(id: string, n: number, seconds: number): Promise<{ scene: number; seconds: number }> {
    const editor = await this.editor(id);
    const actual = await editor.setSceneDuration(n, seconds);
    return { scene: n, seconds: actual };
  }

  // -------------------------------------------------------------- text

  async objects(id: string, scene: number): Promise<SceneObject[]> {
    const editor = await this.editor(id);
    await editor.selectScene(scene);
    return editor.objects();
  }

  async addText(
    id: string,
    scene: number,
    text: string,
    options: { kind?: 'title' | 'subtitle' | 'body'; style?: Parameters<VidsEditor['styleText']>[2] } = {},
  ): Promise<SceneObject> {
    const editor = await this.editor(id);
    const obj = await editor.addText(scene, text, options.kind ?? 'title');
    if (options.style && Object.values(options.style).some((v) => v !== undefined)) {
      await editor.styleText(scene, obj.id, options.style);
    }
    return obj;
  }

  async editText(
    id: string,
    scene: number,
    objectId: string,
    text: string | undefined,
    style?: Parameters<VidsEditor['styleText']>[2],
  ): Promise<SceneObject | undefined> {
    const editor = await this.editor(id);
    let obj: SceneObject | undefined;
    if (text !== undefined) obj = await editor.editText(scene, objectId, text);
    if (style && Object.values(style).some((v) => v !== undefined))
      await editor.styleText(scene, objectId, style);
    return obj ?? (await editor.objects()).find((o) => o.id === objectId);
  }

  async deleteObject(id: string, scene: number, objectId: string): Promise<void> {
    await (await this.editor(id)).deleteObject(scene, objectId);
  }

  // ------------------------------------------------------------- media

  async addMedia(
    id: string,
    scene: number,
    file: string,
    timeoutMs: number,
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    const editor = await this.editor(id);
    return editor.uploadMedia(scene, await assertFile(file), timeoutMs);
  }

  async trimMedia(
    id: string,
    scene: number,
    objectId: string,
    want: { start?: number; end?: number; loop?: boolean },
  ): Promise<{ start?: string; end?: string; loop?: boolean }> {
    return trimMedia(await this.editor(id), scene, objectId, want);
  }

  async setSound(
    id: string,
    scene: number,
    objectId: string,
    want: { volume?: number; mute?: boolean; fadeIn?: number; fadeOut?: number },
  ): Promise<{ volume?: number; mute?: boolean; fadeIn?: number; fadeOut?: number }> {
    return setSound(await this.editor(id), scene, objectId, want);
  }

  async replaceMedia(
    id: string,
    scene: number,
    objectId: string,
    file: string,
    timeoutMs: number,
  ): Promise<SceneObject | undefined> {
    return replaceMedia(await this.editor(id), scene, objectId, await assertFile(file), timeoutMs);
  }

  async fillScene(id: string, scene: number, objectId: string, mode: 'fill' | 'background'): Promise<void> {
    await fillScene(await this.editor(id), scene, objectId, mode);
  }

  async captionStyles(id: string): Promise<CaptionStyle[]> {
    return listCaptionStyles(await this.editor(id));
  }

  async addCaptions(
    id: string,
    options: { scene?: number; style: number; timeoutMs: number },
  ): Promise<{ style: CaptionStyle; scope: 'all' | 'scene' }> {
    return addCaptions(await this.editor(id), options);
  }

  async removeCaptions(id: string): Promise<boolean> {
    return removeCaptions(await this.editor(id));
  }

  /** Insert > Generate an image (AI allowance). */
  async generateImage(
    id: string,
    scene: number,
    options: { prompt: string; aspect?: ImageAspect; style?: ImageStyle; timeoutMs: number },
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    return generateImage(await this.editor(id), scene, options);
  }

  /** Insert > Generate music (AI allowance). */
  async generateMusic(
    id: string,
    scene: number,
    options: { prompt: string; full: boolean; instrumental: boolean; timeoutMs: number },
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    return generateMusic(await this.editor(id), scene, options);
  }

  /** Stock & web search results (Getty Images video/photos, Shutterstock music, stickers). */
  async stockSearch(id: string, query: string, type: StockType, limit: number): Promise<StockResult[]> {
    return searchStock(await this.editor(id), query, type, limit);
  }

  /** Inserts stock result `pick` of `type` for `query` into scene `scene`. */
  async insertStock(
    id: string,
    scene: number,
    query: string,
    type: StockType,
    pick: number,
    timeoutMs: number,
  ): Promise<StockResult & { object?: SceneObject; clip?: TimelineClip }> {
    return insertStock(await this.editor(id), scene, query, type, pick, timeoutMs);
  }

  /** Inserts a Drive image/video/audio file through Insert > Drive & Photos (no OAuth needed). */
  async addDriveMedia(
    id: string,
    scene: number,
    fileUrl: string,
    timeoutMs: number,
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    const editor = await this.editor(id);
    return editor.insertMedia(scene, 'Inserting the Drive file', timeoutMs, async (inserted) => {
      await editor.menu([EDITOR_LABELS.topMenus.insert, EDITOR_LABELS.menuItems.driveAndPhotos]);
      await pickDriveFileByUrl(editor.ui, fileUrl, editor.options.timeoutMs, inserted);
    });
  }

  // ------------------------------------------------------------ format

  async getFormat(id: string): Promise<{ format: string; label: string; available: string[] }> {
    return (await this.editor(id)).getVideoSize();
  }

  async setFormat(id: string, format: VideoFormat): Promise<{ format: VideoFormat; label: string }> {
    const label = await (await this.editor(id)).setVideoSize(format);
    return { format, label };
  }

  /** File > Move to trash (recoverable for 30 days). */
  async trash(
    id: string,
  ): Promise<VideoSummary & { trashed: boolean; changed: boolean; savedToDrive: boolean }> {
    const editor = await this.editor(id, { allowTrashed: true });
    const outcome = await editor.moveToTrash();
    return {
      ...(await this.summary(editor)),
      trashed: outcome !== 'unsaved',
      changed: outcome === 'trashed',
      savedToDrive: outcome !== 'unsaved',
    };
  }

  /**
   * Vids saves a new video to Drive at its first edit; a blank one without a
   * title never gets one. A title round trip saves it without changing it.
   */
  async saveToDrive(id: string): Promise<boolean> {
    const editor = await this.editor(id);
    if (await editor.isSavedToDrive()) return false;
    const title = await editor.title();
    await editor.rename(`${title} (saving)`);
    await editor.rename(title);
    await editor.waitForSaved();
    return true;
  }

  /** "Take out of trash" on the trashed video's editor page. */
  async restore(id: string): Promise<VideoSummary & { trashed: boolean; changed: boolean }> {
    const editor = await this.editor(id, { allowTrashed: true });
    const changed = await editor.restoreFromTrash();
    return { ...(await this.summary(editor)), trashed: false, changed };
  }

  async rename(id: string, title: string): Promise<VideoSummary> {
    const editor = await this.editor(id);
    await editor.rename(title);
    return this.summary(editor);
  }

  // ------------------------------------- sharing and the File menu (no Drive API needed)

  /** Who has access, as the share dialog shows it (synthetic permission ids "ui:…"). */
  async sharing(id: string): Promise<VidPermission[]> {
    const panel = await SharePanel.open(await this.editor(id));
    try {
      return await panel.permissions();
    } finally {
      await panel.close();
    }
  }

  async share(
    id: string,
    target: ShareTarget,
    role: ShareRole,
    options: { notify: boolean; message?: string },
  ): Promise<{ permission: VidPermission; action: 'created' | 'updated' | 'unchanged' }> {
    return shareInDialog(await this.editor(id), target, role, options);
  }

  async unshare(id: string, target: ShareTarget): Promise<VidPermission[]> {
    return unshareInDialog(await this.editor(id), target);
  }

  /** File > Make a copy > Entire video (optionally into a folder, picked by name). */
  async copy(
    id: string,
    options: { name?: string; folderName?: string; samePeople?: boolean; comments?: boolean },
  ): Promise<{ id: string; url: string; name: string }> {
    const copy = await copyInEditor(await this.editor(id), options);
    if (options.folderName) await moveInEditor(await this.editor(copy.id), options.folderName);
    return copy;
  }

  /** File > Move, to a folder picked by name ("My Drive" for the top level). */
  async move(id: string, folderName: string): Promise<VideoSummary> {
    const editor = await this.editor(id);
    await moveInEditor(editor, folderName);
    return this.summary(editor);
  }

  /** File > Export to Drive: an MP4 of the video in My Drive. */
  async exportToDrive(id: string, timeoutMs: number): Promise<{ fileId: string; url: string }> {
    return exportToDriveInEditor(await this.editor(id), timeoutMs);
  }

  /** File > Version history > Name current version. */
  async nameVersion(id: string, name: string): Promise<VideoSummary> {
    const editor = await this.editor(id);
    await nameVersionInEditor(editor, name);
    return this.summary(editor);
  }

  // ---------------------------------------------------- design: transitions, animation, layout

  async transition(
    id: string,
    scene: number,
    type: TransitionType,
    options: { duration?: number; direction?: string },
  ): Promise<{ scene: number; type: TransitionType; duration?: number; direction?: string }> {
    return setTransition(await this.editor(id), scene, type, options);
  }

  async animate(id: string, request: AnimationRequest): Promise<AnimationRequest> {
    return animate(await this.editor(id), request);
  }

  async objectFormat(id: string, scene: number, objectId: string): Promise<ObjectFormat> {
    return getObjectFormat(await this.editor(id), scene, objectId);
  }

  async setObjectFormat(
    id: string,
    scene: number,
    objectId: string,
    want: ObjectFormat & { flip?: 'horizontal' | 'vertical' },
  ): Promise<ObjectFormat> {
    return setObjectFormat(await this.editor(id), scene, objectId, want);
  }

  async findReplace(
    id: string,
    find: string,
    replace: string | undefined,
    options: { matchCase?: boolean; regex?: boolean },
  ): Promise<{ matches: number; replaced: number }> {
    return findReplace(await this.editor(id), find, replace, options);
  }

  /** A PNG of one scene as the editor draws it (the thumbnail fallback). */
  async sceneImage(id: string, scene: number, maxEdge?: number): Promise<Buffer> {
    return (await this.editor(id)).sceneImage(scene, maxEdge);
  }

  // --------------------------------------------------------- templates

  async templates(id: string | undefined): Promise<TemplateInfo[]> {
    const now = new Date().toISOString();
    if (id) {
      const names = await listPanelTemplates(await this.editor(id));
      await this.current?.closeSidePanels();
      return names.map((n) => ({
        name: slugify(n),
        displayName: n,
        source: 'side-panel',
        locator: n,
        lastVerified: now,
      }));
    }
    throw new UsageError('Listing templates needs a video to open the template gallery in.', {
      hint: 'Pass --vid <id>, or run gvids template list --refresh --vid <id>.',
    });
  }

  async applyTemplate(
    id: string,
    template: string,
    options: { after?: number; scenes?: number[] } = {},
  ): Promise<{ inserted: number; scenes: number }> {
    const editor = await this.editor(id);
    const inserted = await applyPanelTemplate(editor, template, options.after, options.scenes);
    return { inserted, scenes: await editor.sceneCount() };
  }

  // --------------------------------------------------------- voiceover

  async voices(id: string): Promise<VoiceInfo[]> {
    const panel = await VoiceoverPanel.open(await this.editor(id), 1);
    const voices = await panel.listVoices();
    await this.current?.closeSidePanels();
    return voices;
  }

  async voiceover(
    id: string,
    scene: number,
    script: string,
    options: { voice?: string; timeoutMs: number },
  ): Promise<TimelineClip> {
    const editor = await this.editor(id);
    const panel = await VoiceoverPanel.open(editor, scene);
    if (options.voice) await panel.selectVoice(options.voice);
    await panel.setScript(script);
    const clip = await panel.insert(scene, options.timeoutMs);
    await editor.closeSidePanels();
    return clip;
  }

  async removeVoiceover(id: string, scene: number): Promise<TimelineClip[]> {
    const editor = await this.editor(id);
    await editor.assertScene(scene);
    return removeVoiceovers(editor, scene);
  }

  // ------------------------------------------------------------ script

  async getScripts(id: string, scene?: number): Promise<Array<{ scene: number; script: string }>> {
    const editor = await this.editor(id);
    const count = await editor.sceneCount();
    const targets = scene ? [scene] : Array.from({ length: count }, (_, i) => i + 1);
    const out: Array<{ scene: number; script: string }> = [];
    for (const n of targets) {
      const panel = await VoiceoverPanel.open(editor, n);
      out.push({ scene: n, script: await panel.readScript() });
    }
    await editor.closeSidePanels();
    return out;
  }

  /** Sets a scene's script (the text used for voiceovers/avatars) without generating audio. */
  async setScript(id: string, scene: number, script: string): Promise<{ scene: number; script: string }> {
    const editor = await this.editor(id);
    const panel = await VoiceoverPanel.open(editor, scene);
    await panel.setScript(script);
    await sleep(800);
    const stored = await panel.readScript();
    await editor.closeSidePanels();
    return { scene, script: stored };
  }

  // ------------------------------------------------------------ avatar

  async avatars(id: string): Promise<AvatarInfo[]> {
    const panel = await AvatarPanel.open(await this.editor(id), 1);
    const avatars = await panel.listAvatars();
    await this.current?.closeSidePanels();
    return avatars;
  }

  async avatar(
    id: string,
    scene: number,
    script: string,
    options: { avatar?: string; timeoutMs: number },
  ): Promise<{ clip?: TimelineClip; object?: SceneObject }> {
    const editor = await this.editor(id);
    const panel = await AvatarPanel.open(editor, scene);
    if (options.avatar) await panel.selectAvatar(options.avatar);
    await panel.setScript(script);
    const result = await panel.generate(scene, options.timeoutMs);
    await editor.closeSidePanels();
    return result;
  }

  // ---------------------------------------------------------------- AI

  async aiOptions(
    id: string,
    mode: AiVideoMode = 'create',
  ): Promise<{ models: string[]; model?: string; aspects: string[]; aspect?: string }> {
    const editor = await this.editor(id);
    const panel = await AiVideoPanel.open(editor);
    await panel.selectTab(mode);
    // Pickers appear once the prompt box is focused.
    await panel.setPrompt(mode, '');
    const models = await panel.models(mode);
    const aspects = await panel.aspectRatios(mode);
    await editor.closeSidePanels();
    return {
      models: models.items,
      ...(models.selected ? { model: models.selected } : {}),
      aspects: aspects.items,
      ...(aspects.selected ? { aspect: aspects.selected } : {}),
    };
  }

  async aiGenerate(
    id: string,
    options: {
      mode: AiVideoMode;
      prompt: string;
      scene?: number;
      images?: string[];
      source?: string;
      model?: string;
      aspect?: string;
      /** Default: the selected scene when `scene` is given, else a new scene (the Vids default). */
      insert?: AiInsertTarget;
      timeoutMs: number;
    },
  ): Promise<{
    clip?: TimelineClip;
    object?: SceneObject;
    inserted: boolean;
    insert: AiInsertTarget;
    model?: string;
    aspect?: string;
  }> {
    const editor = await this.editor(id);
    if (options.scene) await editor.selectScene(options.scene);
    const panel = await AiVideoPanel.open(editor);
    await panel.selectTab(options.mode);
    if (options.mode === 'edit') {
      if (!options.source) throw new UsageError('AI edit needs a source clip.');
      await panel.attachFiles('edit', AI_VIDEO_LABELS.addVideo, [await assertFile(options.source)]);
    }
    if (options.mode === 'animate') {
      const image = options.source ?? options.images?.[0];
      if (!image) throw new UsageError('AI animate needs an image.');
      await panel.attachFiles('animate', AI_VIDEO_LABELS.addImage, [await assertFile(image)]);
    }
    if (options.mode === 'create' && options.images?.length) {
      const files = await Promise.all(options.images.map(assertFile));
      await panel.attachFiles('create', AI_VIDEO_LABELS.ingredients, files);
    }
    await panel.setPrompt(options.mode, options.prompt);
    const model = options.model ? await panel.selectModel(options.mode, options.model) : undefined;
    const aspect = options.aspect ? await panel.selectAspect(options.mode, options.aspect) : undefined;
    const insert = options.insert ?? (options.scene ? 'current-scene' : 'new-scene');
    const result = await panel.generate(options.mode, options.timeoutMs, insert);
    await editor.closeSidePanels();
    await editor.waitForSaved();
    return { ...result, insert, ...(model ? { model } : {}), ...(aspect ? { aspect } : {}) };
  }

  // ------------------------------------------------------------ slides

  /**
   * File > Slides to video. With `ai` (the Vids default) Gemini writes a script
   * and adds voiceover/avatar narration, music and animation; without it the
   * slides are imported as plain scenes.
   */
  async importSlides(
    id: string,
    presentationId: string,
    options: SlidesImportOptions,
  ): Promise<SlidesImportResult> {
    const editor = await this.editor(id);
    // Imported scenes land after the selected scene: select the last one to append.
    await editor.selectScene(await editor.sceneCount());
    const signature = async (): Promise<string> =>
      (await editor.scenes()).map((s) => `${s.text ?? ''}|${s.durationSeconds ?? ''}`).join('\n');
    const before = await editor.sceneCount();
    const beforeSignature = await signature();
    await editor.menu([EDITOR_LABELS.topMenus.file, EDITOR_LABELS.menuItems.slidesToVideo]);
    const picked = await this.slidesDialogs(editor.ui, presentationId, options);
    await this.waitForImport(
      'Slides import',
      editor.page,
      options.timeoutMs,
      async () => (await signature()) !== beforeSignature,
    );
    await editor.dismissPopups();
    await editor.waitForSaved();
    return { scenesBefore: before, scenesAfter: await editor.sceneCount(), ...picked };
  }

  /**
   * Drives the "Select document" picker (already open) and the import dialogs.
   * The picker and dialogs are modal: the editor behind them is aria-hidden.
   */
  private async slidesDialogs(
    ui: UiContext,
    presentationId: string,
    options: SlidesImportOptions,
  ): Promise<{ slides: number; ai: boolean }> {
    const page = ui.page;
    await pickDriveFileByUrl(
      ui,
      `https://docs.google.com/presentation/d/${presentationId}/edit`,
      this.config.browser.timeout,
    );
    const select = page.getByRole('dialog', { name: SLIDES_LABELS.selectSlides });
    // Placeholder checkboxes ("Disabled while loading your slides") come first.
    const boxes = select.getByRole('checkbox', { name: SLIDES_LABELS.slideCheckbox });
    await uiStep(ui, 'The "Select slides" dialog', async () => {
      await boxes.first().waitFor({ timeout: options.timeoutMs });
    });
    const total = await boxes.count();
    if (options.slides) {
      const bad = options.slides.filter((n) => n < 1 || n > total);
      if (bad.length > 0) {
        await select
          .getByRole('button', { name: /^Close dialog$/ })
          .click()
          .catch(() => undefined);
        throw new UsageError(
          `The presentation has ${total} slide${total === 1 ? '' : 's'}; ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} out of range.`,
        );
      }
      const wanted = new Set(options.slides);
      for (let n = 1; n <= total; n++) {
        const box = select.getByRole('checkbox', { name: `Slide ${n}`, exact: true });
        if ((await box.isChecked()) !== wanted.has(n)) await box.click();
      }
    }
    const ai = options.ai ?? true;
    const aiSwitch = select.getByRole('switch', { name: SLIDES_LABELS.aiSwitch });
    if ((await aiSwitch.count()) > 0 && (await aiSwitch.isChecked()) !== ai) await aiSwitch.click();
    await uiStep(ui, 'The "Select slides" confirm button', async () => {
      await select.getByRole('button', { name: SLIDES_LABELS.proceed }).last().click({ timeout: 10_000 });
    });
    if (ai) {
      // Gemini writes the script first; the step appears when it is done.
      const customize = page.getByRole('dialog', { name: SLIDES_LABELS.customize });
      await uiStep(ui, 'The "Edit script and customize video" dialog', async () => {
        await customize.getByRole('radiogroup').first().waitFor({ timeout: options.timeoutMs });
      });
      if (options.narration) {
        const radio = customize.getByRole('radio', {
          name: SLIDES_LABELS.narrationOptions[options.narration],
        });
        if (!(await radio.isChecked())) await radio.click();
      }
      await uiStep(ui, 'The "Create the draft video" button', async () => {
        await customize
          .getByRole('button', { name: SLIDES_LABELS.proceed })
          .last()
          .click({ timeout: 10_000 });
      });
    }
    return { slides: options.slides?.length ?? total, ai };
  }

  /** Waits until no dialog is open (twice in a row) and `done()` holds. */
  private async waitForImport(
    what: string,
    page: Page,
    timeoutMs: number,
    done: () => Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < deadline) {
      const availability = await detectAvailabilityProblem(page);
      if (availability) {
        throw new FeatureUnavailableError(`${what}: ${availability.message}`, {
          code: availability.code,
        });
      }
      const open = await page.getByRole('dialog').filter({ visible: true }).count();
      quiet = open === 0 ? quiet + 1 : 0;
      if (quiet >= 2 && (await done())) return;
      await sleep(1500);
    }
    throw new GenerationTimeoutError(what, timeoutMs, {
      hint: 'The import may still finish in the editor; check with: gvids scene list <id>',
    });
  }

  /** Waits for at least `min` scenes and then for the count to hold still (scenes arrive one by one). */
  private async waitForSceneCount(editor: VidsEditor, min: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let steady = 0;
    while (Date.now() < deadline) {
      const count = await editor.sceneCount();
      steady = count === last ? steady + 1 : 0;
      last = count;
      if (count >= min && steady >= 3) return;
      await sleep(1500);
    }
    throw new GenerationTimeoutError('Adding the drafted scenes', timeoutMs, {
      hint: 'The import may still finish in the editor; check with: gvids scene list <id>',
    });
  }

  // -------------------------------------------------------------- docs

  /**
   * File > Docs to video: Gemini drafts one narration script per scene from a
   * Google Doc; Create adds the scenes with AI voiceover. `scriptOnly` stops at
   * the draft and discards it.
   */
  async importDoc(id: string, documentId: string, options: DocsImportOptions): Promise<DocsImportResult> {
    const editor = await this.editor(id);
    // Like Slides import, new scenes land after the selected scene: select the last one to append.
    await editor.selectScene(await editor.sceneCount());
    const before = await editor.sceneCount();
    await editor.menu([EDITOR_LABELS.topMenus.file, EDITOR_LABELS.menuItems.docsToVideo]);
    const draft = await this.docsDialogs(editor.ui, documentId, options);
    if (!draft.created) return { ...draft, scenesBefore: before, scenesAfter: before };
    await this.waitForImport('Docs to video', editor.page, options.timeoutMs, async () => true);
    // An empty first scene may be replaced, so one scene fewer than drafted also counts.
    await this.waitForSceneCount(editor, before + Math.max(1, draft.script.length - 1), options.timeoutMs);
    await editor.dismissPopups();
    await editor.waitForSaved();
    return { ...draft, scenesBefore: before, scenesAfter: await editor.sceneCount() };
  }

  /** Drives the "Select document" picker (already open) and the script review dialog. */
  private async docsDialogs(
    ui: UiContext,
    documentId: string,
    options: DocsImportOptions,
  ): Promise<{ script: string[]; voice?: string; created: boolean }> {
    const page = ui.page;
    await pickDriveFileByUrl(
      ui,
      `https://docs.google.com/document/d/${documentId}/edit`,
      this.config.browser.timeout,
    );
    const review = page.getByRole('dialog', { name: DOCS_LABELS.review });
    const boxes = review.getByRole('textbox', { name: DOCS_LABELS.sceneScript });
    // Gemini drafts first ("Mapping narrative structure..."); the script boxes appear when it is done.
    const deadline = Date.now() + options.timeoutMs;
    while (
      !(await boxes
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      if (Date.now() > deadline)
        throw new GenerationTimeoutError('Drafting the script from the document', options.timeoutMs);
      const availability = await detectAvailabilityProblem(page);
      if (availability)
        throw new FeatureUnavailableError(`Docs to video: ${availability.message}`, {
          code: availability.code,
        });
      const failure = review.getByText(DOCS_LABELS.failure).filter({ visible: true });
      if ((await failure.count()) > 0) {
        const message = (await failure.first().innerText()).trim();
        await this.discardDocsDraft(page, review);
        throw new GenerationFailedError(`Docs to video: ${message}`);
      }
      await sleep(1000);
    }
    // The scene list only renders the boxes near the view: scroll down collecting "edit scene N".
    const read = async (): Promise<string[]> => {
      const byIndex = new Map<number, string>();
      for (let round = 0; round < 60; round++) {
        const seen = await boxes.evaluateAll((els) =>
          els.map((e) => [e.getAttribute('aria-label') ?? '', (e as HTMLTextAreaElement).value.trim()]),
        );
        const size = byIndex.size;
        for (const [label, value] of seen) {
          const m = DOCS_LABELS.sceneScript.exec(label ?? '');
          if (m) byIndex.set(Number(m[1]), value ?? '');
        }
        if (round > 0 && byIndex.size === size) break;
        await boxes
          .last()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await sleep(250);
      }
      await boxes
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
      return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    };
    /** Scrolls until the box for scene index `i` (0-based) is rendered. */
    const box = async (i: number): Promise<Locator> => {
      const target = review.getByRole('textbox', { name: `edit scene ${i}`, exact: true });
      for (let round = 0; round < 60 && (await target.count()) === 0; round++) {
        await boxes
          .last()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await sleep(250);
      }
      return target;
    };
    let script = await read();
    if (options.script) {
      if (options.script.length > script.length) {
        await this.discardDocsDraft(page, review);
        throw new UsageError(
          `Gemini drafted ${script.length} scene${script.length === 1 ? '' : 's'}, but the script has ${options.script.length} parts.`,
          {
            details: { draft: script },
            hint: 'Give at most one part per drafted scene (details.draft has the draft), or check first with --script-only.',
          },
        );
      }
      for (const [i, text] of options.script.entries()) {
        await uiStep(ui, `The script box of scene ${i + 1}`, async () =>
          (await box(i)).fill(text, { timeout: 10_000 }),
        );
      }
      script = await read();
    }
    if (options.voice) {
      await uiStep(ui, 'The "Select a voiceover style" button', () =>
        review.getByRole('button', { name: DOCS_LABELS.changeVoice }).click({ timeout: 10_000 }),
      );
      const dialog = await voiceDialog(ui, this.config.browser.timeout);
      try {
        await chooseVoice(ui, dialog, options.voice, this.config.browser.timeout);
      } catch (err) {
        await this.discardDocsDraft(page, review);
        throw err;
      }
      await review.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    }
    const voice = await review
      .getByRole('group', { name: DOCS_LABELS.voiceGroup })
      .ariaSnapshot()
      .then((s) => /- text: ([A-Z][\w-]*) [A-Z][^\n]*,/.exec(s)?.[1])
      .catch(() => undefined);
    if (options.scriptOnly) {
      await this.discardDocsDraft(page, review);
      return { script, ...(voice ? { voice } : {}), created: false };
    }
    await uiStep(ui, 'The Docs to video "Create" button', () =>
      review.getByRole('button', { name: DOCS_LABELS.create, exact: true }).click({ timeout: 10_000 }),
    );
    return { script, ...(voice ? { voice } : {}), created: true };
  }

  /** Close dialog > "Discard and close?" > Continue: nothing is added. */
  private async discardDocsDraft(page: Page, review: Locator): Promise<void> {
    await review
      .getByRole('button', { name: DOCS_LABELS.close, exact: true })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    const confirm = page.getByRole('dialog', { name: DOCS_LABELS.discard });
    if (
      await confirm.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await confirm
        .getByRole('button', { name: DOCS_LABELS.discardConfirm, exact: true })
        .click({ timeout: 10_000 });
    }
    await review.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
  }

  // ------------------------------------------------------------ export

  /** Downloads via File > Download in the UI (used for GIF, or MP4 without OAuth). */
  async downloadViaUi(
    id: string,
    format: 'mp4' | 'gif',
    target: string,
    timeoutMs: number,
  ): Promise<{ path: string; suggested: string }> {
    const editor = await this.editor(id);
    // Vids renders in the tab ("Downloading… leave this tab open") and then saves a blob;
    // Playwright surfaces that as a download event.
    const download = armed(editor.page.waitForEvent('download', { timeout: timeoutMs }));
    await editor.menu([
      EDITOR_LABELS.topMenus.file,
      EDITOR_LABELS.menuItems.download,
      format === 'gif' ? EDITOR_LABELS.menuItems.downloadGif : EDITOR_LABELS.menuItems.downloadMp4,
    ]);
    // Vids may refuse instead of rendering ("Can't download GIF" for videos over
    // 30 s). Watch for that dialog while waiting, so the refusal is reported at
    // once rather than after the whole timeout.
    let settled = false;
    const fileOrTimeout = download.finally(() => {
      settled = true;
    });
    const blocked = editor.page
      .getByRole('alertdialog')
      .filter({ hasText: EDITOR_LABELS.downloadBlocked })
      .filter({ visible: true })
      .first();
    const refusal = (async () => {
      while (!settled) {
        if (await blocked.isVisible().catch(() => false)) return blocked;
        await sleep(500);
      }
      return undefined;
    })();
    const outcome = await Promise.race([
      fileOrTimeout.then((file) => ({ file })),
      refusal.then((dialog) => (dialog ? { dialog } : new Promise<never>(() => undefined))),
    ]).catch((err: unknown) => {
      if (err instanceof Error && /Timeout/i.test(err.message)) {
        throw new GenerationTimeoutError(`Rendering the ${format.toUpperCase()} in the browser`, timeoutMs, {
          hint: `Increase --timeout, or use MP4 instead of GIF.`,
        });
      }
      throw err;
    });
    if ('dialog' in outcome) {
      settled = true;
      const text = (await outcome.dialog.innerText().catch(() => ''))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !EDITOR_LABELS.dismissible.close.test(line));
      await outcome.dialog
        .getByRole('button', { name: EDITOR_LABELS.dismissible.close })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
      throw new FeatureUnavailableError(
        `Google Vids refused the ${format.toUpperCase()} download: ${text.join(' — ') || 'no reason given'}`,
        {
          details: { refused: format },
          ...(format === 'gif'
            ? { hint: 'Download an MP4 instead: gvids export <id> out.mp4 --via-browser' }
            : {}),
        },
      );
    }
    const file = outcome.file;
    const failure = await file.failure();
    if (failure) throw new DownloadError(`The browser download failed: ${failure}`);
    await file.saveAs(path.resolve(target));
    await editor.dismissPopups();
    return { path: path.resolve(target), suggested: file.suggestedFilename() };
  }

  async close(): Promise<void> {
    await this.finish().catch(() => undefined);
  }
}
