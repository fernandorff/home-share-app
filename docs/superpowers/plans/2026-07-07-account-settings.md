# Account Settings (Minha conta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit their name, e-mail, username, and password from a new `/conta` page reached via a "Minha conta" item in the user menu.

**Architecture:** Two new/extended API surfaces (`PATCH /api/auth/me` for profile fields, `POST /api/auth/password` for password), backed by two new `AuthService` methods (`updateProfile`, `changePassword`) that reuse the existing `validateUsername`/`validatePassword` validators plus a new `validateEmail`. `GET /api/auth/me` is extended to expose `email` and `hasPassword` so the UI knows which password-section variant to render. The page follows the existing `/casa` page's Card+SectionTitle structure.

**Tech Stack:** Next.js App Router route handlers, Prisma (`prisma.user`), `jose`/`bcryptjs` (existing `lib/auth.ts`), Vitest with the mocked-prisma unit-test pattern already used in `service-guards.test.ts`, next-intl for the 4 locale files.

Design doc: `docs/superpowers/specs/2026-07-07-account-settings-design.md`

---

### Task 1: `AuthService` — `validateEmail`, `updateProfile`, `changePassword`

**Files:**
- Modify: `src/services/auth.service.ts`
- Test: `src/services/auth.service.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `src/services/auth.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { authService } from './auth.service'
import { hashPassword } from '@/lib/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

function baseUser(overrides: Partial<{ password: string | null; email: string | null }> = {}) {
  return {
    id: 1,
    publicId: 'pub-1',
    name: 'Fernando',
    username: 'fernando',
    email: 'old@x.com',
    password: 'hash-of-something',
    googleId: null,
    ...overrides,
  }
}

describe('validateEmail', () => {
  it('accepts a well-formed address', () => {
    expect(authService.validateEmail('a@b.com')).toBeNull()
  })

  it('rejects malformed addresses', () => {
    expect(authService.validateEmail('not-an-email')).not.toBeNull()
    expect(authService.validateEmail('a@b')).not.toBeNull()
    expect(authService.validateEmail('@b.com')).not.toBeNull()
  })

  it('rejects overly long addresses', () => {
    const long = 'a'.repeat(250) + '@b.com'
    expect(authService.validateEmail(long)).not.toBeNull()
  })
})

describe('updateProfile', () => {
  it('updates name only, without touching email/username or requiring a password', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())
    mockPrisma.user.update.mockResolvedValue({ ...baseUser(), name: 'New Name' })

    const result = await authService.updateProfile(1, { name: 'New Name' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data).toEqual({ name: 'New Name' })
  })

  it('requires the current password when email is changing and the user has one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())

    const result = await authService.updateProfile(1, { email: 'new@x.com' })

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects a wrong current password', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))

    const result = await authService.updateProfile(1, { email: 'new@x.com', currentPassword: 'wrong-pw' })

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('accepts the right current password and persists the email change', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: hash })) // the user being updated
      .mockResolvedValueOnce(null) // email-conflict precheck: no one else has it
    mockPrisma.user.update.mockResolvedValue(baseUser({ password: hash, email: 'new@x.com' }))

    const result = await authService.updateProfile(1, { email: 'new@x.com', currentPassword: 'correct-pw' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data).toEqual({ email: 'new@x.com' })
  })

  it('does not ask for a password when email is resubmitted unchanged', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())
    mockPrisma.user.update.mockResolvedValue(baseUser())

    // Same value as already stored — a client that always submits the full form
    // must not be asked to confirm a field it didn't actually change.
    const result = await authService.updateProfile(1, { name: 'Fernando', email: 'old@x.com' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data).toEqual({ name: 'Fernando' })
  })

  it('rejects an e-mail already used by another account', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: hash }))
      .mockResolvedValueOnce({ id: 2 }) // someone else already has this email

    const result = await authService.updateProfile(1, { email: 'taken@x.com', currentPassword: 'correct-pw' })

    expect(result).toMatchObject({ code: 'EMAIL_TAKEN' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('skips the current-password check for a Google-only account (no password set)', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: null }))
      .mockResolvedValueOnce(null)
    mockPrisma.user.update.mockResolvedValue(baseUser({ password: null, username: 'newname' }))

    const result = await authService.updateProfile(1, { username: 'newname' })

    expect('user' in result).toBe(true)
    expect(mockPrisma.user.update).toHaveBeenCalled()
  })
})

describe('changePassword', () => {
  it('requires the current password when one is already set', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, undefined, 'new-password-123')

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects a wrong current password', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))

    const result = await authService.changePassword(1, 'wrong-pw', 'new-password-123')

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('changes the password when the current one is correct', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))
    mockPrisma.user.update.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, 'correct-pw', 'new-password-123')

    expect(result).toEqual({ ok: true })
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data.password).not.toBe(hash)
    expect(typeof data.password).toBe('string')
  })

  it('lets a Google-only account define a password with no current-password check', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: null }))
    mockPrisma.user.update.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, undefined, 'new-password-123')

    expect(result).toEqual({ ok: true })
    expect(mockPrisma.user.update).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/auth.service.test.ts`
Expected: FAIL — `authService.validateEmail is not a function` (and similarly for `updateProfile`/`changePassword`).

- [ ] **Step 3: Implement `validateEmail`, `updateProfile`, `changePassword`**

In `src/services/auth.service.ts`, add a new regex constant next to the existing `USERNAME_REGEX` (currently line 5):

```ts
const USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
```

Add two exported result types near the existing `LoginResult` (currently lines 7-11):

```ts
export type UpdateProfileResult =
  | { user: { id: number; publicId: string; name: string; username: string; email: string | null; hasPassword: boolean } }
  | { error: string; code: string }

export type ChangePasswordResult =
  | { ok: true }
  | { error: string; code: string }
```

Add `validateEmail` right after `validatePassword` (currently ends at line 29, before `async register`):

```ts
  validateEmail(email: string): string | null {
    if (email.length > 254 || !EMAIL_REGEX.test(email)) {
      return 'E-mail inválido'
    }
    return null
  }
```

Add `updateProfile` and `changePassword` as new methods, right after `getUserWithGroups` (currently ends at line 168, just before the class's closing `}`):

```ts
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

    const data: { name?: string; email?: string; username?: string } = {}
    if (input.name !== undefined) data.name = input.name
    if (emailChanging) data.email = input.email
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

  async changePassword(
    userId: number,
    currentPassword: string | undefined,
    newPassword: string
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
    }

    await prisma.user.update({
      where: { id: userId },
      data: { password: await hashPassword(newPassword) },
    })
    return { ok: true }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/auth.service.test.ts`
Expected: PASS (all cases above).

- [ ] **Step 5: Commit**

```bash
git add src/services/auth.service.ts src/services/auth.service.test.ts
git commit -m "feat(auth): add updateProfile/changePassword to AuthService"
```

---

### Task 2: Extend `GET /api/auth/me` with `email` + `hasPassword`

**Files:**
- Modify: `src/services/auth.service.ts` (`getUserWithGroups`, lines 132-168)
- Modify: `src/lib/types.ts` (`Me` interface, lines 25-34)

- [ ] **Step 1: Extend the Prisma select + return shape**

In `getUserWithGroups`, change the `select` block from:

```ts
      select: {
        id: true,
        publicId: true,
        name: true,
        username: true,
        memberships: {
```

to:

```ts
      select: {
        id: true,
        publicId: true,
        name: true,
        username: true,
        email: true,
        password: true,
        memberships: {
```

And change the return object from:

```ts
    return {
      id: user.id,
      publicId: user.publicId,
      name: user.name,
      username: user.username,
      groups: user.memberships.map(m => ({
```

to:

```ts
    return {
      id: user.id,
      publicId: user.publicId,
      name: user.name,
      username: user.username,
      email: user.email,
      hasPassword: user.password !== null,
      groups: user.memberships.map(m => ({
```

`password` is selected only to derive the boolean and is never included in the returned object — confirm no other line in this method spreads `user` directly (it doesn't; every field is assigned explicitly).

- [ ] **Step 2: Update the `Me` type**

In `src/lib/types.ts`, change:

```ts
export interface Me {
  user: {
    id: number;
    publicId: string;
    name: string;
    username: string;
    groups: MeGroup[];
  };
  activeGroupId: number | null;
}
```

to:

```ts
export interface Me {
  user: {
    id: number;
    publicId: string;
    name: string;
    username: string;
    email: string | null;
    hasPassword: boolean;
    groups: MeGroup[];
  };
  activeGroupId: number | null;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (no other file destructures `Me.user` in a way that a `toEqual`/exhaustive shape check would break — this is an additive field).

- [ ] **Step 4: Commit**

```bash
git add src/services/auth.service.ts src/lib/types.ts
git commit -m "feat(auth): expose email + hasPassword on GET /api/auth/me"
```

---

### Task 3: `PATCH /api/auth/me` route

**Files:**
- Modify: `src/app/api/auth/me/route.ts`

- [ ] **Step 1: Add the `PATCH` handler**

Current file (23 lines) only exports `GET`. Add these imports to the top (merge with the existing `NextResponse`/`cookies`/`authService`/`handleApiError, requireSession`/`GROUP_COOKIE` imports):

```ts
import { rateLimit } from '@/lib/rate-limit'
```

Append this export after the existing `GET` function:

```ts
export async function PATCH(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : undefined
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : undefined
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined

    if (name === undefined && email === undefined && username === undefined) {
      return NextResponse.json({ error: 'Informe ao menos um campo para atualizar', code: 'NO_FIELDS' }, { status: 400 })
    }
    if (name !== undefined && (!name || name.length > 80)) {
      return NextResponse.json({ error: 'Nome é obrigatório (máx. 80 caracteres)', code: 'INVALID_NAME' }, { status: 400 })
    }
    if (email !== undefined) {
      const emailError = authService.validateEmail(email)
      if (emailError) {
        return NextResponse.json({ error: emailError, code: 'INVALID_EMAIL' }, { status: 400 })
      }
    }
    if (username !== undefined) {
      const usernameError = authService.validateUsername(username)
      if (usernameError) {
        return NextResponse.json({ error: usernameError, code: 'INVALID_USERNAME' }, { status: 400 })
      }
    }

    // Brute-forcing the current-password confirmation is only reachable through email/username
    // changes — gate those attempts per authenticated user (shared bucket with /api/auth/password).
    if (email !== undefined || username !== undefined) {
      if (!rateLimit(`account:pw:${check.session.userId}`, 10, 60_000)) {
        return NextResponse.json({ error: 'Muitas tentativas. Tente novamente em instantes.', code: 'RATE_LIMITED' }, { status: 429 })
      }
    }

    const result = await authService.updateProfile(check.session.userId, { name, email, username, currentPassword })
    if ('error' in result) {
      const status =
        result.code === 'CURRENT_PASSWORD_REQUIRED' || result.code === 'CURRENT_PASSWORD_INVALID' ? 401
        : result.code === 'EMAIL_TAKEN' || result.code === 'USERNAME_TAKEN' ? 409
        : result.code === 'NOT_FOUND' ? 404
        : 400
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }

    return NextResponse.json({ user: result.user })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar conta')
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/app/api/auth/me/route.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/me/route.ts
git commit -m "feat(auth): add PATCH /api/auth/me for profile updates"
```

---

### Task 4: `POST /api/auth/password` route

**Files:**
- Create: `src/app/api/auth/password/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    // Same shared bucket as PATCH /api/auth/me — both gate on the same current-password secret.
    if (!rateLimit(`account:pw:${check.session.userId}`, 10, 60_000)) {
      return NextResponse.json({ error: 'Muitas tentativas. Tente novamente em instantes.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    const body = await request.json()
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

    const passwordError = authService.validatePassword(newPassword)
    if (passwordError) {
      return NextResponse.json({ error: passwordError, code: 'INVALID_PASSWORD' }, { status: 400 })
    }

    const result = await authService.changePassword(check.session.userId, currentPassword, newPassword)
    if ('error' in result) {
      const status = result.code === 'NOT_FOUND' ? 404 : 401
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar a senha')
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/app/api/auth/password/route.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/password/route.ts
git commit -m "feat(auth): add POST /api/auth/password (change or define password)"
```

---

### Task 5: i18n — `Account` namespace, new `ApiErrors` keys, `Nav.myAccount`

**Files:**
- Modify: `src/messages/pt.json`
- Modify: `src/messages/en.json`
- Modify: `src/messages/es.json`
- Modify: `src/messages/fr.json`

- [ ] **Step 1: Add `Nav.myAccount` to all four files**

In each file's `Nav` object, add a `myAccount` key (placed next to `houseAndMembers`):

- `pt.json`: `"myAccount": "Minha conta",`
- `en.json`: `"myAccount": "My account",`
- `es.json`: `"myAccount": "Mi cuenta",`
- `fr.json`: `"myAccount": "Mon compte",`

- [ ] **Step 2: Add the `Account` namespace to all four files**

Insert as a new top-level key (e.g. right after `"Activity"`, matching where other page namespaces live).

`pt.json`:

```json
"Account": {
  "title": "Minha conta",
  "subtitle": "Seus dados de acesso.",
  "profileTitle": "Dados pessoais",
  "name": "Nome",
  "email": "E-mail",
  "username": "Usuário",
  "currentPassword": "Senha atual",
  "currentPasswordHint": "Necessária pra confirmar a troca de e-mail ou usuário.",
  "save": "Salvar",
  "profileSaved": "Dados atualizados.",
  "profileError": "Erro ao atualizar os dados.",
  "passwordTitle": "Senha",
  "passwordHint": "Mínimo 8 caracteres",
  "definePasswordTitle": "Definir uma senha",
  "definePasswordHint": "Sua conta usa login do Google. Defina uma senha pra também poder entrar com usuário e senha.",
  "changePasswordHint": "Escolha uma nova senha.",
  "newPassword": "Nova senha",
  "confirmPassword": "Confirmar nova senha",
  "passwordMismatch": "As senhas não coincidem.",
  "passwordSaved": "Senha atualizada.",
  "passwordDefined": "Senha definida. Agora você também pode entrar com usuário e senha.",
  "passwordError": "Erro ao atualizar a senha.",
  "saveButton": "Salvar senha",
  "defineButton": "Definir senha"
}
```

`en.json`:

```json
"Account": {
  "title": "My account",
  "subtitle": "Your access details.",
  "profileTitle": "Personal details",
  "name": "Name",
  "email": "E-mail",
  "username": "Username",
  "currentPassword": "Current password",
  "currentPasswordHint": "Required to confirm an e-mail or username change.",
  "save": "Save",
  "profileSaved": "Details updated.",
  "profileError": "Error updating your details.",
  "passwordTitle": "Password",
  "passwordHint": "Minimum 8 characters",
  "definePasswordTitle": "Set a password",
  "definePasswordHint": "Your account signs in with Google. Set a password so you can also log in with a username and password.",
  "changePasswordHint": "Choose a new password.",
  "newPassword": "New password",
  "confirmPassword": "Confirm new password",
  "passwordMismatch": "Passwords don't match.",
  "passwordSaved": "Password updated.",
  "passwordDefined": "Password set. You can now also log in with a username and password.",
  "passwordError": "Error updating the password.",
  "saveButton": "Save password",
  "defineButton": "Set password"
}
```

`es.json`:

```json
"Account": {
  "title": "Mi cuenta",
  "subtitle": "Tus datos de acceso.",
  "profileTitle": "Datos personales",
  "name": "Nombre",
  "email": "Correo electrónico",
  "username": "Usuario",
  "currentPassword": "Contraseña actual",
  "currentPasswordHint": "Necesaria para confirmar el cambio de correo o usuario.",
  "save": "Guardar",
  "profileSaved": "Datos actualizados.",
  "profileError": "Error al actualizar los datos.",
  "passwordTitle": "Contraseña",
  "passwordHint": "Mínimo 8 caracteres",
  "definePasswordTitle": "Definir una contraseña",
  "definePasswordHint": "Tu cuenta inicia sesión con Google. Define una contraseña para también poder entrar con usuario y contraseña.",
  "changePasswordHint": "Elige una nueva contraseña.",
  "newPassword": "Nueva contraseña",
  "confirmPassword": "Confirmar nueva contraseña",
  "passwordMismatch": "Las contraseñas no coinciden.",
  "passwordSaved": "Contraseña actualizada.",
  "passwordDefined": "Contraseña definida. Ahora también puedes entrar con usuario y contraseña.",
  "passwordError": "Error al actualizar la contraseña.",
  "saveButton": "Guardar contraseña",
  "defineButton": "Definir contraseña"
}
```

`fr.json`:

```json
"Account": {
  "title": "Mon compte",
  "subtitle": "Vos informations de connexion.",
  "profileTitle": "Informations personnelles",
  "name": "Nom",
  "email": "E-mail",
  "username": "Nom d'utilisateur",
  "currentPassword": "Mot de passe actuel",
  "currentPasswordHint": "Requis pour confirmer un changement d'e-mail ou de nom d'utilisateur.",
  "save": "Enregistrer",
  "profileSaved": "Informations mises à jour.",
  "profileError": "Erreur lors de la mise à jour des informations.",
  "passwordTitle": "Mot de passe",
  "passwordHint": "8 caractères minimum",
  "definePasswordTitle": "Définir un mot de passe",
  "definePasswordHint": "Votre compte se connecte avec Google. Définissez un mot de passe pour pouvoir aussi vous connecter avec un identifiant et un mot de passe.",
  "changePasswordHint": "Choisissez un nouveau mot de passe.",
  "newPassword": "Nouveau mot de passe",
  "confirmPassword": "Confirmer le nouveau mot de passe",
  "passwordMismatch": "Les mots de passe ne correspondent pas.",
  "passwordSaved": "Mot de passe mis à jour.",
  "passwordDefined": "Mot de passe défini. Vous pouvez maintenant aussi vous connecter avec un identifiant et un mot de passe.",
  "passwordError": "Erreur lors de la mise à jour du mot de passe.",
  "saveButton": "Enregistrer le mot de passe",
  "defineButton": "Définir le mot de passe"
}
```

- [ ] **Step 3: Add 4 new `ApiErrors` keys to all four files**

`pt.json`:
```json
"INVALID_EMAIL": "E-mail inválido",
"EMAIL_TAKEN": "Este e-mail já está em uso",
"CURRENT_PASSWORD_REQUIRED": "Informe sua senha atual",
"CURRENT_PASSWORD_INVALID": "Senha atual incorreta"
```

`en.json`:
```json
"INVALID_EMAIL": "Invalid e-mail",
"EMAIL_TAKEN": "This e-mail is already in use",
"CURRENT_PASSWORD_REQUIRED": "Enter your current password",
"CURRENT_PASSWORD_INVALID": "Current password is incorrect"
```

`es.json`:
```json
"INVALID_EMAIL": "Correo electrónico inválido",
"EMAIL_TAKEN": "Este correo ya está en uso",
"CURRENT_PASSWORD_REQUIRED": "Ingresa tu contraseña actual",
"CURRENT_PASSWORD_INVALID": "La contraseña actual es incorrecta"
```

`fr.json`:
```json
"INVALID_EMAIL": "E-mail invalide",
"EMAIL_TAKEN": "Cet e-mail est déjà utilisé",
"CURRENT_PASSWORD_REQUIRED": "Indiquez votre mot de passe actuel",
"CURRENT_PASSWORD_INVALID": "Mot de passe actuel incorrect"
```

- [ ] **Step 4: Verify all four locales still have the same key count**

Run:
```bash
for f in en pt es fr; do echo -n "$f: "; node -e "const m=require('./src/messages/$f.json'); let n=0; (function c(o){for(const k in o){n++; if(o[k]&&typeof o[k]==='object')c(o[k])}})(m); console.log(n)"; done
```
Expected: all four print the same number (465 + 1 Nav key + 22 Account keys + 4 ApiErrors keys = 492 each — the exact base number doesn't matter, only that all four match).

- [ ] **Step 5: Commit**

```bash
git add src/messages/en.json src/messages/pt.json src/messages/es.json src/messages/fr.json
git commit -m "feat(i18n): add Account namespace + profile/password error codes"
```

---

### Task 6: `/conta` page

**Files:**
- Create: `src/app/(app)/conta/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { Card, SectionTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import type { Me } from "@/lib/types";

export default function ContaPage() {
  const t = useTranslations("Account");
  const { me, refresh } = useSession();

  if (!me) return null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="label-mono text-faint">{t("subtitle")}</p>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      </div>

      <ProfileSection me={me} onSaved={refresh} />
      <PasswordSection hasPassword={me.user.hasPassword} />
    </div>
  );
}

function ProfileSection({ me, onSaved }: { me: Me; onSaved: () => Promise<void> }) {
  const t = useTranslations("Account");
  const apiErr = useApiError();
  const toast = useToast();

  const original = {
    name: me.user.name,
    email: me.user.email ?? "",
    username: me.user.username,
  };
  const [name, setName] = useState(original.name);
  const [email, setEmail] = useState(original.email);
  const [username, setUsername] = useState(original.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const sensitiveChanged =
    email.trim().toLowerCase() !== original.email.toLowerCase() ||
    username.trim().toLowerCase() !== original.username;
  const needsCurrentPassword = sensitiveChanged && me.user.hasPassword;
  const dirty = name.trim() !== original.name || sensitiveChanged;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch("/api/auth/me", {
        name: name.trim(),
        email: email.trim(),
        username: username.trim(),
        ...(needsCurrentPassword ? { currentPassword } : {}),
      });
      setCurrentPassword("");
      await onSaved();
      toast(t("profileSaved"), "success");
    } catch (err) {
      toast(apiErr(err, t("profileError")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("profileTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} className="flex flex-col gap-4">
          <Field label={t("name")} htmlFor="account-name">
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
            />
          </Field>
          <Field label={t("email")} htmlFor="account-email">
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
            />
          </Field>
          <Field label={t("username")} htmlFor="account-username">
            <Input
              id="account-username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              maxLength={30}
              autoCapitalize="none"
              required
            />
          </Field>
          {needsCurrentPassword && (
            <Field
              label={t("currentPassword")}
              htmlFor="account-current-password"
              hint={t("currentPasswordHint")}
            >
              <Input
                id="account-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          )}
          <Button
            type="submit"
            loading={saving}
            disabled={!dirty || (needsCurrentPassword && !currentPassword)}
            className="w-full sm:w-auto"
          >
            {t("save")}
          </Button>
        </form>
      </Card>
    </section>
  );
}

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("Account");
  const apiErr = useApiError();
  const toast = useToast();
  const { refresh } = useSession();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast(t("passwordMismatch"), "error");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/auth/password", {
        ...(hasPassword ? { currentPassword } : {}),
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      if (hasPassword) {
        toast(t("passwordSaved"), "success");
      } else {
        toast(t("passwordDefined"), "success");
        await refresh();
      }
    } catch (err) {
      toast(apiErr(err, t("passwordError")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("passwordTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} className="flex flex-col gap-4">
          <p className="text-sm text-faint">
            {hasPassword ? t("changePasswordHint") : t("definePasswordHint")}
          </p>
          {hasPassword && (
            <Field label={t("currentPassword")} htmlFor="password-current">
              <Input
                id="password-current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          )}
          <Field label={t("newPassword")} htmlFor="password-new" hint={t("passwordHint")}>
            <Input
              id="password-new"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label={t("confirmPassword")} htmlFor="password-confirm">
            <Input
              id="password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Button
            type="submit"
            loading={saving}
            disabled={(hasPassword && !currentPassword) || newPassword.length < 8 || confirm.length < 8}
            className="w-full sm:w-auto"
          >
            {hasPassword ? t("saveButton") : t("defineButton")}
          </Button>
        </form>
      </Card>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/conta/page.tsx"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/conta/page.tsx"
git commit -m "feat(conta): add account settings page (profile + password)"
```

---

### Task 7: "Minha conta" entry in `UserMenu`

**Files:**
- Modify: `src/components/app/AppChrome.tsx` (`UserMenu`, currently lines 108-140)

- [ ] **Step 1: Add the menu item**

Change:

```tsx
      <MenuLabel>@{me.user.username}</MenuLabel>
      <MenuItem onSelect={() => router.push("/casa")}>{t("houseAndMembers")}</MenuItem>
      <MenuSeparator />
```

to:

```tsx
      <MenuLabel>@{me.user.username}</MenuLabel>
      <MenuItem onSelect={() => router.push("/conta")}>{t("myAccount")}</MenuItem>
      <MenuItem onSelect={() => router.push("/casa")}>{t("houseAndMembers")}</MenuItem>
      <MenuSeparator />
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/app/AppChrome.tsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/app/AppChrome.tsx
git commit -m "feat(nav): add \"Minha conta\" entry to the user menu"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `src/services/auth.service.test.ts` cases (113 previous + 12 new ≈ 125).

- [ ] **Step 2: Typecheck + lint (whole project)**

Run: `npx tsc --noEmit`
Run: `npx eslint src/services/auth.service.ts src/lib/types.ts src/app/api/auth/me/route.ts src/app/api/auth/password/route.ts "src/app/(app)/conta/page.tsx" src/components/app/AppChrome.tsx`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npx next build`
Expected: succeeds, `/conta`, `PATCH /api/auth/me` and `/api/auth/password` show up in the route list.

- [ ] **Step 4: Manual/e2e verification (Playwright, dev server)**

Using the same approach as the earlier audit-trail verification in this session (mint a `bolitas_session` cookie signed with the `.env` `JWT_SECRET`, or reuse an already-authenticated browser session):

1. Navigate to `/despesas`, open the user menu, confirm "Minha conta" appears above "Casa e membros", click it → lands on `/conta`.
2. Change only the name, save → toast success, no "senha atual" field ever appeared, name updates immediately in the header (no re-login).
3. Edit the e-mail field → "Senha atual" field appears; try to save with it empty → button stays disabled (client-side) confirming the guard; fill a wrong password → 401 toast with the `CURRENT_PASSWORD_INVALID` message; fill the right one → success, toast shown.
4. On a Google-only account (or the seeded one after temporarily nulling its password in the test DB), open the Senha section → shows "Defina uma senha" copy with only new+confirm fields; define one → success toast, then reload the page and confirm the section now shows "Senha atual" (i.e. `hasPassword` flipped).
5. Try to reuse an already-taken e-mail/username from the other seeded user → `EMAIL_TAKEN`/`USERNAME_TAKEN` toast, no crash.

- [ ] **Step 5: Update auto-memory**

Add a short note (new or appended memory file) recording: the account-settings feature exists (`/conta`, `PATCH /api/auth/me`, `POST /api/auth/password`), the current-password confirmation rule (email/username changes + password changes require it; name-only doesn't), and that Google-only accounts can define a password from this screen. This is the kind of "what changed and why" fact worth keeping for future sessions.

- [ ] **Step 6: Ask the user for the branch and confirm before any final commit is pushed**

Per project convention: confirm which branch to commit/push to before doing so (this plan's per-task commits are local; do not `git push` without an explicit go-ahead).

---

## Self-review notes (already applied above)

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-07-account-settings-design.md` maps to a task — data model (no-op, confirmed), both API routes (Tasks 3-4), the service layer (Task 1), `GET /api/auth/me` extension (Task 2), UI (Task 6), menu entry (Task 7), i18n (Task 5), rate limiting (folded into Tasks 3-4), testing (Task 1 unit tests + Task 8 manual/e2e).
- **Type consistency:** `UpdateProfileResult`/`ChangePasswordResult` (Task 1) match the shapes consumed by the routes in Tasks 3-4 (`'error' in result`, `result.code`, `result.user`) and by the `Me` type extended in Task 2 (`email`, `hasPassword`) consumed by the page in Task 6.
- **No placeholders:** every step has literal, complete code — no "add validation" or "similar to Task N" shortcuts.
