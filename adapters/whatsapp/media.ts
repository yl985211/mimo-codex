import * as path from 'node:path'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'

// Lazy-load baileys to avoid bundling in sidecar
let baileysModule: any = null

async function getBaileys() {
  if (!baileysModule) {
    baileysModule = await import('@whiskeysockets/baileys')
  }
  return baileysModule
}

function unwrapMessage(message: any): any {
  if (!baileysModule) return message
  return baileysModule.normalizeMessageContent(message)
}

function resolveMediaMime(message: any): string | undefined {
  return message.imageMessage?.mimetype
    ?? message.videoMessage?.mimetype
    ?? message.documentMessage?.mimetype
    ?? message.audioMessage?.mimetype
    ?? message.stickerMessage?.mimetype
    ?? (message.audioMessage ? 'audio/ogg; codecs=opus' : undefined)
    ?? (message.imageMessage ? 'image/jpeg' : undefined)
    ?? (message.videoMessage ? 'video/mp4' : undefined)
    ?? (message.stickerMessage ? 'image/webp' : undefined)
}

function resolveMediaName(message: any, mimeType: string): string {
  const explicit = message.documentMessage?.fileName
  if (explicit?.trim()) return path.basename(explicit)

  const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'bin'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `whatsapp-${timestamp}.${ext}`
}

export class WhatsAppMediaService {
  private sock: any
  private attachmentStore: AttachmentStore

  constructor(sock: any, attachmentStore: AttachmentStore) {
    this.sock = sock
    this.attachmentStore = attachmentStore
  }

  async downloadMessageMedia(
    message: any,
    sessionId: string,
  ): Promise<LocalAttachment | null> {
    const content = unwrapMessage(message.message as any)
    if (!content) return null

    const mimeType = resolveMediaMime(content)
    if (!mimeType) return null

    const baileys = await getBaileys()
    const buffer = await baileys.downloadMediaMessage(message, 'buffer', {})
    if (!buffer || buffer.length === 0) return null

    const name = resolveMediaName(content, mimeType)
    const kind = mimeType.startsWith('image/') ? 'image' : 'file'

    const stored = await this.attachmentStore.save(buffer, {
      sessionId,
      name,
      mimeType,
      kind,
    })

    return {
      kind,
      name,
      mimeType,
      buffer,
      path: stored.path,
      size: buffer.length,
    }
  }

  async sendMedia(
    jid: string,
    buffer: Buffer,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    if (mimeType.startsWith('image/')) {
      await this.sock.sendMessage(jid, {
        image: buffer,
        caption,
        mimetype: mimeType,
      })
    } else if (mimeType.startsWith('video/')) {
      await this.sock.sendMessage(jid, {
        video: buffer,
        caption,
        mimetype: mimeType,
      })
    } else if (mimeType.startsWith('audio/')) {
      await this.sock.sendMessage(jid, {
        audio: buffer,
        mimetype: mimeType,
        ptt: true,
      })
    } else {
      await this.sock.sendMessage(jid, {
        document: buffer,
        caption,
        mimetype: mimeType,
        fileName: `file-${Date.now()}`,
      })
    }
  }
}
