import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { hashPassword, verifyPassword } from '@/lib/auth'

const USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/

export type LoginResult =
  | { status: 'ok'; user: { id: number; publicId: string; name: string } }
  | { status: 'requires_password_setup'; user: { id: number; publicId: string; name: string } }
  | { status: 'invalid' }

class AuthService {
  validateUsername(username: string): string | null {
    if (!USERNAME_REGEX.test(username)) {
      return 'Usuário deve ter 3-30 caracteres (letras minúsculas, números, ponto, hífen ou underline)'
    }
    return null
  }

  validatePassword(password: string): string | null {
    if (typeof password !== 'string' || password.length < 8) {
      return 'Senha deve ter pelo menos 8 caracteres'
    }
    if (password.length > 72) {
      return 'Senha deve ter no máximo 72 caracteres'
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

    // Legacy users (pre-auth era) have no password yet — first login defines it.
    if (user.password === null) {
      return { status: 'requires_password_setup', user: publicUser }
    }

    const valid = await verifyPassword(password, user.password)
    return valid ? { status: 'ok', user: publicUser } : { status: 'invalid' }
  }

  /** Sets the password ONLY for users that don't have one yet (legacy first access). */
  async setInitialPassword(username: string, password: string): Promise<LoginResult> {
    const user = await prisma.user.findUnique({ where: { username } })
    if (!user) return { status: 'invalid' }
    if (user.password !== null) return { status: 'invalid' }

    await prisma.user.update({
      where: { id: user.id },
      data: { password: await hashPassword(password) },
    })
    return { status: 'ok', user: { id: user.id, publicId: user.publicId, name: user.name } }
  }

  async getUserWithGroups(userId: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        publicId: true,
        name: true,
        username: true,
        memberships: {
          select: {
            role: true,
            colorIndex: true,
            group: { select: { id: true, publicId: true, name: true, joinCode: true } },
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
      groups: user.memberships.map(m => ({
        id: m.group.id,
        publicId: m.group.publicId,
        name: m.group.name,
        role: m.role,
        colorIndex: m.colorIndex,
        // joinCode only exposed to admins (it grants entry to the house)
        joinCode: m.role === 'ADMIN' ? m.group.joinCode : null,
      })),
    }
  }
}

export const authService = new AuthService()
