# Home Share

🌐 [English](README.md) · [Português](README.pt-BR.md) · **Español** · [Français](README.fr.md)

Gastos compartidos del hogar: registra lo que gastas, divídelo entre compañeros de
piso (**en partes iguales**, **por importe** o **con un control deslizante de %**) y mira
**quién le debe a quién**. Incluye una lista de la compra, plataformas de pago y soporte
para varios hogares.

**🔗 En vivo:** https://homeshare.fernandorffdev.com

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

- Servidor **Rust / Axum** (`server/`) — sirve la API JSON (`/api/*`) y la app web, mismo origen
- App web **React 19** compilada con **Vite** (fuentes en `src/`, rutas con react-router) · i18n con use-intl (EN/PT/ES/FR)
- **Tailwind v4** + primitivas Radix · fuentes **Space Mono** / **JetBrains Mono**
- **PostgreSQL** (Neon) — el servidor Rust habla con ella directamente (tokio-postgres + deadpool); **Prisma** se conserva solo como herramienta de migraciones (`prisma/schema.prisma` + `prisma/migrations`)
- Tests: **Vitest** (app web) · `cargo test` (servidor)

La antigua versión en Next.js ahora está en https://github.com/fernandorff/home-share-next.

## Ejecutar en local

```bash
npm run db:up                 # Postgres 16 local (Docker, localhost:5433)
cp .env.example .env.local    # lo lee `npm run db:migrate`
npm install
npm run db:migrate            # aplica prisma/migrations
# terminal 1 — el servidor Rust (lee las variables de entorno de la shell, no de un archivo):
cd server && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/homeshare_dev JWT_SECRET=dev-secret cargo run   # http://localhost:8080
# terminal 2 — la app web con hot reload; /api va al servidor Rust:
npm run dev                   # http://localhost:5173
```

Gates (los mismos que ejecuta el CI): `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build` · `cargo test --manifest-path server/Cargo.toml`.

Cambios de esquema: edita `prisma/schema.prisma`, ejecuta `npx prisma migrate dev --name <change>`
contra la base de datos local y haz commit de la nueva carpeta en `prisma/migrations` — el CI
falla cuando el esquema cambia sin una migración. Las migraciones deben ser aditivas.
`npm run db:reset` recrea la base de datos local y vuelve a aplicar todas las migraciones.

### Variables de entorno

El servidor las lee del entorno (ver `.env.example`).

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | sí | Postgres (Neon) |
| `JWT_SECRET` | sí | secreto para firmar la sesión |
| `APP_ENV` | no | `production` es el único despliegue que los buscadores pueden indexar |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | habilita el inicio de sesión con Google. Redirección: `<origin>/api/auth/google/callback` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | no | Web Push: define las tres o ninguna |
| `SENTRY_DSN` | no | informe de errores |

La app web también recibe `NEXT_PUBLIC_VAPID_PUBLIC_KEY` y `VITE_SENTRY_*` en tiempo de build (Docker `--build-arg`).

## Autenticación

Sesión mediante **cookie httpOnly** (`homeshare_session`, JWT HS256) — el cliente nunca ve
ni almacena un token. El **hogar activo** vive en una cookie separada (`homeshare_group`);
para cambiarlo, `POST /api/groups/active`. Al ser del mismo origen, no hay CORS. El inicio
de sesión con Google reutiliza la misma cookie de sesión.

El dinero se maneja en **céntimos enteros** para evitar la deriva de coma flotante;
las divisiones siempre suman exactamente el total.

## Estructura

```
server/              # servidor Rust (Axum)
├── src/main.rs      # rutas y capas
├── src/routes/      # un archivo por grupo de rutas
└── src/             # auth.rs, house.rs, money.rs, db.rs, config.rs
src/                 # app web
├── vite/            # entrada (main.tsx) y rutas (routes.tsx)
├── app/auth/**      # páginas públicas: login, register, set-password
├── app/(app)/**     # área con sesión: expenses, balances, shopping, catalogs, activity, house, settings, notifications, recurring
├── components/
├── lib/
└── messages/        # i18n (EN/PT/ES/FR)
prisma/              # esquema + migraciones
Dockerfile           # una imagen: binario Rust + build de Vite
fly.toml
```

## Despliegue

La producción corre en **Fly.io** (app `home-share`, São Paulo), con una base de datos
**Neon** en São Paulo y **Cloudflare** por delante, en https://homeshare.fernandorffdev.com.
No hay entorno de staging.

Una sola rama, `main`. Trabaja en una rama corta → PR a `main` (el `ci` de GitHub Actions
ejecuta los gates) → merge = despliegue: el job `deploy` aplica las migraciones pendientes
a la base de datos de producción (`prisma migrate deploy`), ejecuta
`flyctl deploy --remote-only` y después comprueba `https://homeshare.fernandorffdev.com/api/health?db=1`.

Un workflow `keep-warm` llama a esa URL cada 5 minutos para mantener caliente el compute de Neon.
