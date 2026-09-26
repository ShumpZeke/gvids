import { NotFoundError, UsageError } from '../errors/errors.js';
import { mapGoogleApiError } from '../errors/map.js';
import type { DriveCommentResource, DriveReplyResource, DriveTransport } from './transport.js';

export interface VidRevision {
  id: string;
  modifiedTime?: string;
  /** Display name of the person whose edit created this version. */
  modifiedBy?: string;
  keepForever?: boolean;
}

export interface VidCommentReply {
  id: string;
  content: string;
  author?: string;
  createdTime?: string;
  /** "resolve" or "reopen" when the reply changed the comment's state. */
  action?: string;
}

export interface VidComment extends VidCommentReply {
  resolved: boolean;
  modifiedTime?: string;
  /** The text the comment is anchored to, if any. */
  quotedText?: string;
  replies: VidCommentReply[];
}

const REPLY_FIELDS = 'id,content,action,createdTime,author(displayName,emailAddress)';
const COMMENT_FIELDS = `id,content,createdTime,modifiedTime,resolved,deleted,quotedFileContent(value),author(displayName,emailAddress),replies(${REPLY_FIELDS})`;

function reply(r: DriveReplyResource): VidCommentReply {
  return {
    id: r.id ?? '',
    content: r.content ?? '',
    ...(r.author?.displayName ? { author: r.author.displayName } : {}),
    ...(r.createdTime ? { createdTime: r.createdTime } : {}),
    ...(r.action ? { action: r.action } : {}),
  };
}

function comment(c: DriveCommentResource): VidComment {
  return {
    ...reply(c),
    resolved: Boolean(c.resolved),
    ...(c.modifiedTime ? { modifiedTime: c.modifiedTime } : {}),
    ...(c.quotedFileContent?.value ? { quotedText: c.quotedFileContent.value } : {}),
    replies: (c.replies ?? []).map(reply),
  };
}

/** Version history and comments of a Vids file (Drive API revisions, comments, replies). */
export class CollaborationService {
  constructor(private readonly transport: DriveTransport) {}

  async revisions(id: string): Promise<VidRevision[]> {
    try {
      const list = await this.transport.listRevisions(
        id,
        'id,modifiedTime,keepForever,lastModifyingUser(displayName,emailAddress)',
      );
      return list.map((r) => ({
        id: r.id ?? '',
        ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}),
        ...(r.lastModifyingUser?.displayName ? { modifiedBy: r.lastModifyingUser.displayName } : {}),
        ...(r.keepForever ? { keepForever: true } : {}),
      }));
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'list versions' });
    }
  }

  async comments(id: string, options: { includeResolved?: boolean } = {}): Promise<VidComment[]> {
    let list: DriveCommentResource[];
    try {
      list = await this.transport.listComments(id, COMMENT_FIELDS);
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'list comments' });
    }
    return list
      .filter((c) => !c.deleted)
      .map(comment)
      .filter((c) => options.includeResolved || !c.resolved);
  }

  async add(id: string, text: string): Promise<VidComment> {
    const content = text.trim();
    if (!content) throw new UsageError('The comment text must not be empty.');
    try {
      return comment(await this.transport.createComment(id, { content }, COMMENT_FIELDS));
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'add a comment' });
    }
  }

  async reply(id: string, commentId: string, text: string): Promise<VidCommentReply> {
    const content = text.trim();
    if (!content) throw new UsageError('The reply text must not be empty.');
    await this.find(id, commentId);
    try {
      return reply(await this.transport.createReply(id, commentId, { content }, REPLY_FIELDS));
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'reply to the comment' });
    }
  }

  /** Resolves (or reopens) a comment with an optional closing note. Idempotent. */
  async setResolved(
    id: string,
    commentId: string,
    resolved: boolean,
    note?: string,
  ): Promise<{ comment: VidComment; changed: boolean }> {
    const current = await this.find(id, commentId);
    if (current.resolved === resolved) return { comment: current, changed: false };
    try {
      await this.transport.createReply(
        id,
        commentId,
        { action: resolved ? 'resolve' : 'reopen', ...(note?.trim() ? { content: note.trim() } : {}) },
        REPLY_FIELDS,
      );
    } catch (err) {
      throw mapGoogleApiError(err, {
        fileId: id,
        action: resolved ? 'resolve the comment' : 'reopen the comment',
      });
    }
    return { comment: await this.find(id, commentId), changed: true };
  }

  private async find(id: string, commentId: string): Promise<VidComment> {
    const found = (await this.comments(id, { includeResolved: true })).find((c) => c.id === commentId);
    if (!found) {
      throw new NotFoundError(`Comment ${commentId} was not found on this video.`, {
        hint: `List comments with: gvids comments list ${id}`,
      });
    }
    return found;
  }
}
