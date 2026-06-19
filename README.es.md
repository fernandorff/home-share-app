# Home Share

🌐 [English](README.md) · [Português](README.pt-BR.md) · **Español** · [Français](README.fr.md)

Gastos compartidos del hogar: registra lo que gastas, divídelo entre compañeros de
piso (**en partes iguales**, **por importe** o **con un control deslizante de %**) y mira
**quién le debe a quién**. Incluye una lista de la compra, plataformas de pago y soporte
para varios hogares.

**🔗 En vivo:** https://home-share-app-xi.vercel.app

Una interfaz **retro editorial mono** (estética de recibo/libro contable): monoespaciada,
números tabulares, líneas punteadas y un único acento de "sello". Mobile-first, con
animaciones de entrada escalonadas y esqueletos de carga (respetando `prefers-reduced-motion`).

## Funcionalidades

- **Autenticación** — usuario/contraseña + **inicio de sesión con Google**, sesión mediante **cookie httpOnly**
  (JWT). Flujo de primer acceso para usuarios heredados (establecer contraseña).
- **Hogares** — crear / unirse con un código de 6 caracteres, roles ADMIN/MEMBER, cambiar de hogar.
- **Gastos** — crear/editar/eliminar, dividir **en partes iguales / por importe / por %** (céntimos exactos),
  selección en bloque, **importación/exportación CSV**, ordenación y paginación.
- **Balances** — quién le debe a quién, con el conjunto mínimo de transferencias para saldar cuentas.
- **Lista de la compra** y **plataformas de pago** (con reasignación al eliminar).

## Stack

- **Next.js 16** (App Router) + **React 19** — monolito: frontend y API en una sola app, mismo origen
- **Tailwind v4** + primitivas Radix · fuentes **Space Mono** / **JetBrains Mono**
- **Prisma 7** (`@prisma/adapter-pg`) + **PostgreSQL** (Neon)
- **jose** (JWT) · **bcryptjs** · **Vitest**

## Ejecutar en local

```bash
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npm install
npx prisma db push        # create the schema in the database
npm run dev               # http://localhost:3000
npm run test              # vitest (currency, balance, csv-parser, auth)
```

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | sí | Postgres (Neon) |
| `JWT_SECRET` | sí en producción | secreto para firmar la sesión |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | habilita el inicio de sesión con Google. Redirección: `<origin>/api/auth/google/callback` |

## Autenticación

Sesión mediante **cookie httpOnly** (`bolitas_session`, JWT HS256) — el cliente nunca ve
ni almacena un token. El **hogar activo** vive en una cookie separada (`bolitas_group`);
para cambiarlo, `POST /api/groups/active`. Al ser del mismo origen, no hay CORS. El inicio
de sesión con Google reutiliza la misma cookie de sesión.

El dinero se maneja en **céntimos enteros** (`src/lib/currency`) para evitar la deriva de
coma flotante; las divisiones siempre suman exactamente el total.

## Estructura

```
src/
├── app/
│   ├── api/**       # route handlers (auth[+google], groups, expenses, balances, platforms, shopping-items, health)
│   ├── auth/**      # public pages: login, register, set-password
│   └── (app)/**     # logged-in area: expenses, balances, shopping, platforms, household
├── components/      # ui/ (retro-mono design system) · app/ · expenses/ · auth/
├── lib/             # auth, api (client), session, currency, balance, format, members, ...
└── services/        # auth, group, expense, platform, shopping-item
prisma/              # schema + config
```

## Despliegue

Alojado en **Vercel** con una base de datos **Neon** (integración). El build ejecuta
`prisma generate && next build` — el esquema se aplica de forma deliberada con
`prisma db push` (no en CI). Dos entornos: **Production** (rama `main`) y
**Preview** (ramas/PRs).

## Exploraciones de diseño

La carpeta [`design-samples/`](design-samples) contiene 7 direcciones visuales exploradas
antes de decidirse por retro editorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Abre `index.html` para comparar.
