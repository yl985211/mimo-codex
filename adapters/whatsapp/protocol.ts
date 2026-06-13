import * as crypto from 'node:crypto'
import * as path from 'node:path'

// Lazy-load session module to avoid bundling @whiskeysockets/baileys in sidecar
let sessionModule: typeof import('./session.js') | null = null

async function getSession() {
  if (!sessionModule) {
    sessionModule = await import('./session.js')
  }
  return sessionModule
}

export type WhatsAppLoginStartResult = {
  sessionKey: string
  qr?: string
  message: string
}

export type WhatsAppLoginPollResult =
  | {
      connected: true
      accountJid: string
      authDir: string
      message: string
    }
  | {
      connected: false
      status: 'waiting' | 'expired' | 'error'
      qr?: string
      message: string
    }

type LoginSession = {
  authDir: string
  sock: any
  createSocket: (options: any) => Promise<any>
  qr?: string
  connected: boolean
  accountJid?: string
  error?: string
  restarts: number
  createdAt: number
}

const LOGIN_TTL_MS = 2 * 60 * 1000
const WAIT_FOR_QR_MS = 20_000
const POST_PAIRING_RESTART_STATUS = 515
const TIMED_OUT_STATUS = 408
const MAX_LOGIN_RESTARTS = 5
const sessions = new Map<string, LoginSession>()

export async function startWhatsAppLoginWithQr(options: {
  authDir: string
  force?: boolean
  createSocket?: (options: any) => Promise<any>
}): Promise<WhatsAppLoginStartResult> {
  const session = await getSession()
  cleanupExpiredSessions()
  const authDir = path.resolve(options.authDir)
  if (options.force) {
    closeSessionsForAuthDir(authDir)
    session.clearWhatsAppAuth(authDir)
  }

  const sessionKey = crypto.randomUUID()
  const loginSession: LoginSession = {
    authDir,
    sock: undefined as any,
    createSocket: options.createSocket ?? session.createWhatsAppSocket,
    connected: false,
    restarts: 0,
    createdAt: Date.now(),
  }
  sessions.set(sessionKey, loginSession)
  const qrPromise = waitForQr(loginSession)
  try {
    await connectLoginSocket(sessionKey, loginSession)
  } catch (err) {
    sessions.delete(sessionKey)
    throw err
  }

  await qrPromise
  return {
    sessionKey,
    qr: loginSession.qr,
    message: loginSession.qr
      ? 'Scan this QR in WhatsApp > Linked devices.'
      : 'Waiting for WhatsApp QR code...',
  }
}

async function connectLoginSocket(sessionKey: string, loginSession: LoginSession): Promise<void> {
  const session = await getSession()
  const sock = await loginSession.createSocket({
    authDir: loginSession.authDir,
    onQr: (qr: string) => {
      loginSession.qr = qr
    },
  })
  loginSession.sock = sock

  sock.ev.on('connection.update', async (update: any) => {
    if (sessions.get(sessionKey) !== loginSession || loginSession.sock !== sock) return
    if (update.qr) {
      loginSession.qr = update.qr
    }
    if (update.connection === 'open') {
      await session.waitForWhatsAppCredsSave(loginSession.authDir)
      loginSession.connected = true
      loginSession.accountJid = sock.user?.id ?? ''
    }
    if (update.connection === 'close' && !loginSession.connected) {
      if (session.isWhatsAppLoggedOut(update.lastDisconnect?.error)) {
        loginSession.error = 'WhatsApp session logged out. Please scan again.'
        return
      }
      const status = session.getWhatsAppDisconnectStatus(update.lastDisconnect?.error)
      const shouldRestart = (status === POST_PAIRING_RESTART_STATUS || status === TIMED_OUT_STATUS)
        && loginSession.restarts < MAX_LOGIN_RESTARTS
      if (!shouldRestart) {
        loginSession.error = 'WhatsApp login connection closed. Please retry.'
        return
      }
      loginSession.restarts += 1
      session.closeWhatsAppSocket(sock, 'WhatsApp login restart')
      try {
        await session.waitForWhatsAppCredsSave(loginSession.authDir)
        await connectLoginSocket(sessionKey, loginSession)
      } catch (err) {
        if (sessions.get(sessionKey) !== loginSession) return
        console.warn('[WhatsApp] Login socket restart failed:', err instanceof Error ? err.message : err)
        loginSession.error = 'WhatsApp login connection closed. Please retry.'
      }
    }
  })
}

export async function pollWhatsAppLoginWithQr(options: {
  sessionKey: string
}): Promise<WhatsAppLoginPollResult> {
  const session = await getSession()
  cleanupExpiredSessions()
  const loginSession = sessions.get(options.sessionKey)
  if (!loginSession) {
    return {
      connected: false,
      status: 'expired',
      message: 'WhatsApp login session expired. Generate a new QR code.',
    }
  }

  if (loginSession.connected) {
    await session.waitForWhatsAppCredsSave(loginSession.authDir)
    const accountJid = loginSession.accountJid || loginSession.sock.user?.id || ''
    session.closeWhatsAppSocket(loginSession.sock, 'WhatsApp login complete')
    sessions.delete(options.sessionKey)
    return {
      connected: true,
      accountJid,
      authDir: loginSession.authDir,
      message: 'WhatsApp linked successfully.',
    }
  }

  if (loginSession.error) {
    session.closeWhatsAppSocket(loginSession.sock, 'WhatsApp login error')
    sessions.delete(options.sessionKey)
    return {
      connected: false,
      status: 'error',
      message: loginSession.error,
    }
  }

  return {
    connected: false,
    status: 'waiting',
    qr: loginSession.qr,
    message: loginSession.qr
      ? 'Waiting for WhatsApp scan confirmation...'
      : 'Waiting for WhatsApp QR code...',
  }
}

export async function logoutWhatsAppAuth(authDir: string): Promise<void> {
  const session = await getSession()
  closeSessionsForAuthDir(path.resolve(authDir))
  session.clearWhatsAppAuth(authDir)
}

function waitForQr(loginSession: LoginSession): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (loginSession.qr || loginSession.connected || Date.now() - started > WAIT_FOR_QR_MS) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })
}

async function cleanupExpiredSessions(): Promise<void> {
  const session = await getSession()
  const now = Date.now()
  for (const [sessionKey, loginSession] of sessions) {
    if (now - loginSession.createdAt <= LOGIN_TTL_MS) continue
    session.closeWhatsAppSocket(loginSession.sock, 'WhatsApp login expired')
    sessions.delete(sessionKey)
  }
}

async function closeSessionsForAuthDir(authDir: string): Promise<void> {
  const session = await getSession()
  for (const [sessionKey, loginSession] of sessions) {
    if (path.resolve(loginSession.authDir) !== authDir) continue
    session.closeWhatsAppSocket(loginSession.sock, 'WhatsApp login superseded')
    sessions.delete(sessionKey)
  }
}
