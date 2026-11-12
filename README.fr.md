# Home Share

🌐 [English](README.md) · [Português](README.pt-BR.md) · [Español](README.es.md) · **Français**

Dépenses partagées du foyer : enregistrez les dépenses, répartissez-les entre colocataires
(**à parts égales**, **par montant** ou **avec un curseur en %**), et voyez **qui doit quoi à qui**.
Comprend une liste de courses, des plateformes de paiement et la prise en charge de plusieurs foyers.

**🔗 En ligne :** https://homeshare.fernandorffdev.com

Une interface **rétro éditoriale mono** (esthétique ticket de caisse / grand livre) : police à chasse fixe,
chiffres tabulaires, filets pointillés et un unique accent « tampon ». Conçue d'abord pour mobile, avec des
animations d'entrée décalées et des squelettes de chargement (respectant `prefers-reduced-motion`).

## Fonctionnalités

- **Auth** — nom d'utilisateur/mot de passe + **connexion Google**, session via **cookie httpOnly**
  (JWT). Flux de premier accès pour les utilisateurs hérités (définition du mot de passe).
- **Foyers** — créez / rejoignez avec un code à 6 caractères, rôles ADMIN/MEMBER, changement de foyer.
- **Dépenses** — créer/modifier/supprimer, répartir **à parts égales / par montant / en %** (centimes exacts),
  sélection groupée, **import/export CSV**, tri et pagination.
- **Soldes** — qui doit quoi à qui, avec l'ensemble minimal de transferts pour régler les comptes.
- **Liste de courses** et **plateformes de paiement** (avec réaffectation lors de la suppression).

## Stack

- Serveur **Rust / Axum** (`server/`) — sert l'API JSON (`/api/*`) et l'application web, même origine
- Application web **React 19** compilée par **Vite** (sources dans `src/`, routes via react-router) · i18n avec use-intl (EN/PT/ES/FR)
- **Tailwind v4** + primitives Radix · polices **Space Mono** / **JetBrains Mono**
- **PostgreSQL** (Neon) — le serveur Rust lui parle directement (tokio-postgres + deadpool) ; **Prisma** n'est conservé que comme outil de migrations (`prisma/schema.prisma` + `prisma/migrations`)
- Tests : **Vitest** (application web) · `cargo test` (serveur)

L'ancienne version Next.js se trouve désormais sur https://github.com/fernandorff/home-share-next.

## Exécuter en local

```bash
npm run db:up                 # Postgres 16 local (Docker, localhost:5433)
cp .env.example .env.local    # lu par `npm run db:migrate`
npm install
npm run db:migrate            # applique prisma/migrations
# terminal 1 — le serveur Rust (lit les variables d'environnement du shell, pas d'un fichier) :
cd server && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/homeshare_dev JWT_SECRET=dev-secret cargo run   # http://localhost:8080
# terminal 2 — l'application web avec rechargement à chaud ; /api est redirigé vers le serveur Rust :
npm run dev                   # http://localhost:5173
```

Gates (les mêmes que la CI) : `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build` · `cargo test --manifest-path server/Cargo.toml`.

Changements de schéma : modifiez `prisma/schema.prisma`, lancez `npx prisma migrate dev --name <change>`
sur la base locale et commitez le nouveau dossier dans `prisma/migrations` — la CI échoue lorsque
le schéma change sans migration. Les migrations doivent être additives. `npm run db:reset`
recrée la base locale et réapplique toutes les migrations.

### Variables d'environnement

Lues par le serveur depuis l'environnement (voir `.env.example`).

| Variable | Obligatoire | Description |
|---|---|---|
| `DATABASE_URL` | oui | Postgres (Neon) |
| `JWT_SECRET` | oui | secret de signature des sessions |
| `APP_ENV` | non | `production` est le seul déploiement que les moteurs de recherche peuvent indexer |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | non | active la connexion Google. Redirection : `<origin>/api/auth/google/callback` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | non | Web Push : définir les trois ou aucune |
| `SENTRY_DSN` | non | rapport d'erreurs |

L'application web reçoit aussi `NEXT_PUBLIC_VAPID_PUBLIC_KEY` et `VITE_SENTRY_*` au moment du build (Docker `--build-arg`).

## Authentification

Session via **cookie httpOnly** (`homeshare_session`, JWT HS256) — le client ne voit jamais
ni ne stocke de jeton. Le **foyer actif** réside dans un cookie distinct (`homeshare_group`) ;
pour en changer, `POST /api/groups/active`. Étant de même origine, il n'y a pas de CORS. La connexion
Google réutilise le même cookie de session.

L'argent est géré en **centimes entiers** pour éviter les dérives de virgule flottante ;
les répartitions s'additionnent toujours exactement au total.

## Structure

```
server/              # serveur Rust (Axum)
├── src/main.rs      # routes et couches
├── src/routes/      # un fichier par groupe de routes
└── src/             # auth.rs, house.rs, money.rs, db.rs, config.rs
src/                 # application web
├── vite/            # entrée (main.tsx) et routes (routes.tsx)
├── app/auth/**      # pages publiques : login, register, set-password
├── app/(app)/**     # espace connecté : expenses, balances, shopping, catalogs, activity, house, settings, notifications, recurring
├── components/
├── lib/
└── messages/        # i18n (EN/PT/ES/FR)
prisma/              # schéma + migrations
Dockerfile           # une image : binaire Rust + build Vite
fly.toml
```

## Déploiement

La production tourne sur **Fly.io** (application `home-share`, São Paulo), avec une base de
données **Neon** à São Paulo et **Cloudflare** devant, sur https://homeshare.fernandorffdev.com.
Il n'y a pas d'environnement de staging.

Une seule branche, `main`. Travaillez sur une branche courte → PR vers `main` (le `ci` de
GitHub Actions exécute les gates) → merge = déploiement : le job `deploy` applique les
migrations en attente à la base de production (`prisma migrate deploy`), lance
`flyctl deploy --remote-only`, puis vérifie `https://homeshare.fernandorffdev.com/api/health?db=1`.

Un workflow `keep-warm` appelle cette URL toutes les 5 minutes pour garder le compute Neon actif.
