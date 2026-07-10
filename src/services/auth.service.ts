import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { hashPassword, verifyPassword } from '@/lib/auth'

const USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REAUTH_WINDOW_SECONDS = 15 * 60

// Top of most-breached-password lists (e.g. Have I Been Pwned) — a length check alone lets
// "password"/"12345678" through, which is a real account-takeover risk on a money ledger.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', '11111111', '00000000', 'iloveyou', 'admin123',
  'welcome1', 'letmein1', 'abc123456', 'senha123', 'senha1234', 'brasil123',
])

export type LoginResult =
  | { status: 'ok'; user: { id: number; publicId: string; name: string } }
  | { status: 'use_google' }
  | { status: 'invalid' }

export type UpdateProfileResult =
  | { user: { id: number; publicId: string; name: string; username: string; email: string | null; hasPassword: boolean } }
  | { error: string; code: string }

export type ChangePasswordResult =
  | { ok: true }
  | { error: string; code: string }

class AuthService {
  validateUsername(username: string): string | null {
    if (!USERNAME_REGEX.test(username)) {
      return 'Usuário deve ter 3-30 caracteres (letras minúsculas, números, ponto, hífen ou underline)'
    }
    return null
  }

  validatePassword(password: string): { error: string; code: string } | null {
    if (typeof password !== 'string' || password.length < 8) {
      return { error: 'Senha deve ter pelo menos 8 caracteres', code: 'INVALID_PASSWORD' }
    }
    if (password.length > 72) {
      return { error: 'Senha deve ter no máximo 72 caracteres', code: 'INVALID_PASSWORD' }
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      return { error: 'Essa senha é muito comum. Escolha uma senha mais difícil de adivinhar', code: 'PASSWORD_TOO_COMMON' }
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return { error: 'Senha deve conter letras e números', code: 'PASSWORD_NO_COMPLEXITY' }
    }
    return null
  }

  validateEmail(email: string): string | null {
    if (email.length > 254 || !EMAIL_REGEX.test(email)) {
      return 'E-mail inválido'
    }
    return null
  }

  async register(name: string, username: string, password: string) {
    const existing = await prisma.user.findUnique({ where: { username } })
    if (existing) {
      return { error: 'Este usuário já existe' }
    }

    const user = await prisma.user.create({
      data: {
        publicId: uuidv7(),
        name: name.trim(),
        username,
        password: await hashPassword(password),
      },
      select: { id: true, publicId: true, name: true },
    })
    return { user }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await prisma.user.findUnique({ where: { username } })
    if (!user) return { status: 'invalid' }

    const publicUser = { id: user.id, publicId: user.publicId, name: user.name }

    if (user.password === null) {
      // Google accounts are passwordless by design — they log in via Google.
      if (user.googleId !== null) return { status: 'use_google' }
      // A password-less, Google-less row shouldn't exist in practice (the old unauthenticated
      // "legacy first access" claim-by-username flow was retired as a security fix — anyone could
      // claim any such account just by knowing its username). Treat it the same as any other
      // wrong-credentials case: never reveal that this state is different from "wrong password".
      return { status: 'invalid' }
    }

    const valid = await verifyPassword(password, user.password)
    return valid ? { status: 'ok', user: publicUser } : { status: 'invalid' }
  }

  /** Derive a unique, regex-valid username from a Google email (or googleId fallback). */
  private async uniqueUsernameFromEmail(email: string | undefined, fallback: string): Promise<string> {
    const local = (email?.split('@')[0] ?? fallback).toLowerCase()
    let base = local.replace(/[^a-z0-9._-]/g, '').slice(0, 24)
    if (base.length < 3) base = `user${base}`
    base = base.slice(0, 24)

    let candidate = base
    let n = 0
    while (await prisma.user.findUnique({ where: { username: candidate } })) {
      n += 1
      candidate = `${base}${n}`.slice(0, 30)
    }
    return candidate
  }

  /**
   * Google login: match by googleId, else link an existing account by email, else create a new
   * passwordless user. Reuses the same session afterwards.
   *
   * SECURITY: the by-email fallback only auto-links when the matched row is BOTH unclaimed
   * (googleId === null) AND its email was itself verified (by an earlier Google login, or a
   * trusted one-time backfill) — never a plain self-service PATCH /api/auth/me value. Trusting an
   * unverified email here would let anyone pre-claim someone else's address on their own account
   * and silently hijack that person's first-ever Google login (or, for an already-linked account,
   * overwrite its googleId and permanently steal it). If the matched row fails either check, the
   * disputed email is dropped (not planted on the new row either) and a fresh account is created.
   */
  async findOrCreateGoogleUser(profile: { googleId: string; email?: string; name?: string }) {
    let user = await prisma.user.findUnique({ where: { googleId: profile.googleId } })
    let emailForNewUser = profile.email ?? null

    if (!user && profile.email) {
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email } })
      if (byEmail && byEmail.googleId === null && byEmail.emailVerified) {
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleId: profile.googleId },
        })
      } else if (byEmail) {
        emailForNewUser = null
      }
    }

    if (!user) {
      const username = await this.uniqueUsernameFromEmail(profile.email, profile.googleId)
      user = await prisma.user.create({
        data: {
          publicId: uuidv7(),
          name: profile.name?.trim() || profile.email?.split('@')[0] || 'Usuário',
          username,
          email: emailForNewUser,
          emailVerified: emailForNewUser !== null,
          googleId: profile.googleId,
          password: null,
        },
      })
    }

    return { id: user.id, publicId: user.publicId, name: user.name }
  }

  async getUserWithGroups(userId: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        publicId: true,
        name: true,
        username: true,
        email: true,
        password: true,
        memberships: {
          select: {
            role: true,
            colorIndex: true,
            group: { select: { id: true, publicId: true, name: true, joinCode: true, currency: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!user) return null

    return {
      id: user.id,
      publicId: user.publicId,
      name: user.name,
      username: user.username,
      email: user.email,
      hasPassword: user.password !== null,
      groups: user.memberships.map(m => ({
        id: m.group.id,
        publicId: m.group.publicId,
        name: m.group.name,
        currency: m.group.currency,
        role: m.role,
        colorIndex: m.colorIndex,
        // joinCode only exposed to admins (it grants entry to the house)
        joinCode: m.role === 'ADMIN' ? m.group.joinCode : null,
      })),
    }
  }

  async updateProfile(
    userId: number,
    input: { name?: string; email?: string; username?: string; currentPassword?: string }
  ): Promise<UpdateProfileResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return { error: 'Usuário não encontrado', code: 'NOT_FOUND' }

    const emailChanging = input.email !== undefined && input.email !== user.email
    const usernameChanging = input.username !== undefined && input.username !== user.username

    if ((emailChanging || usernameChanging) && user.password !== null) {
      if (!input.currentPassword) {
        return { error: 'Senha atual é obrigatória', code: 'CURRENT_PASSWORD_REQUIRED' }
      }
      const ok = await verifyPassword(input.currentPassword, user.password)
      if (!ok) {
        return { error: 'Senha atual incorreta', code: 'CURRENT_PASSWORD_INVALID' }
      }
    }

    if (emailChanging) {
      const conflict = await prisma.user.findUnique({ where: { email: input.email } })
      if (conflict) return { error: 'Este e-mail já está em uso', code: 'EMAIL_TAKEN' }
    }
    if (usernameChanging) {
      const conflict = await prisma.user.findUnique({ where: { username: input.username } })
      if (conflict) return { error: 'Este usuário já existe', code: 'USERNAME_TAKEN' }
    }

    const data: { name?: string; email?: string; emailVerified?: boolean; username?: string } = {}
    if (input.name !== undefined) data.name = input.name
    // A self-service email change is never trusted for OAuth auto-linking — always demote
    // emailVerified back to false, even if the new value happens to match a real address.
    if (emailChanging) { data.email = input.email; data.emailVerified = false }
    if (usernameChanging) data.username = input.username

    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data,
        select: { id: true, publicId: true, name: true, username: true, email: true },
      })
      return { user: { ...updated, hasPassword: user.password !== null } }
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined
      if (code === 'P2002') {
        if (emailChanging) return { error: 'Este e-mail já está em uso', code: 'EMAIL_TAKEN' }
        if (usernameChanging) return { error: 'Este usuário já existe', code: 'USERNAME_TAKEN' }
      }
      throw e
    }
  }

  /**
   * @param sessionIssuedAt the caller's JWT `iat` (unix seconds) — only consulted when DEFINING a
   *   password for the first time (see REAUTH_WINDOW_SECONDS below).
   */
  async changePassword(
    userId: number,
    currentPassword: string | undefined,
    newPassword: string,
    sessionIssuedAt: number
  ): Promise<ChangePasswordResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return { error: 'Usuário não encontrado', code: 'NOT_FOUND' }

    if (user.password !== null) {
      if (!currentPassword) {
        return { error: 'Senha atual é obrigatória', code: 'CURRENT_PASSWORD_REQUIRED' }
      }
      const ok = await verifyPassword(currentPassword, user.password)
      if (!ok) {
        return { error: 'Senha atual incorreta', code: 'CURRENT_PASSWORD_INVALID' }
      }
    } else {
      // Defining a password for the very first time (Google-only account) has no prior secret to
      // confirm — narrow the risk instead by requiring a RECENT login. A stolen/borrowed session
      // cookie can still be valid for up to 30 days (SESSION_MAX_AGE_SECONDS); without this check
      // it could be silently upgraded into a permanent, independent credential the real owner
      // never notices. This does not apply once a password already exists (branch above).
      const ageSeconds = Math.floor(Date.now() / 1000) - sessionIssuedAt
      if (ageSeconds > REAUTH_WINDOW_SECONDS) {
        return { error: 'Faça login novamente para definir uma senha', code: 'REAUTH_REQUIRED' }
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: { password: await hashPassword(newPassword) },
    })
    return { ok: true }
  }
}

export const authService = new AuthService()
