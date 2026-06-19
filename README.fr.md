# Home Share

🌐 [English](README.md) · [Português](README.pt-BR.md) · [Español](README.es.md) · **Français**

Dépenses partagées du foyer : enregistrez les dépenses, répartissez-les entre colocataires
(**à parts égales**, **par montant** ou **avec un curseur en %**), et voyez **qui doit quoi à qui**.
Comprend une liste de courses, des plateformes de paiement et la prise en charge de plusieurs foyers.

**🔗 En ligne :** https://home-share-app-xi.vercel.app

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

- **Next.js 16** (App Router) + **React 19** — monolithe : frontend et API dans une même application, même origine
- **Tailwind v4** + primitives Radix · polices **Space Mono** / **JetBrains Mono**
- **Prisma 7** (`@prisma/adapter-pg`) + **PostgreSQL** (Neon)
- **jose** (JWT) · **bcryptjs** · **Vitest**

## Exécuter en local

```bash
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npm install
npx prisma db push        # create the schema in the database
npm run dev               # http://localhost:3000
npm run test              # vitest (currency, balance, csv-parser, auth)
```

### Variables d'environnement

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | oui | Postgres (Neon) |
| `JWT_SECRET` | oui en production | secret de signature des sessions |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | non | active la connexion Google. Redirection : `<origin>/api/auth/google/callback` |

## Authentification

Session via **cookie httpOnly** (`bolitas_session`, JWT HS256) — le client ne voit jamais
ni ne stocke de jeton. Le **foyer actif** réside dans un cookie distinct (`bolitas_group`) ;
pour en changer, `POST /api/groups/active`. Étant de même origine, il n'y a pas de CORS. La connexion
Google réutilise le même cookie de session.

L'argent est géré en **centimes entiers** (`src/lib/currency`) pour éviter les dérives de virgule
flottante ; les répartitions s'additionnent toujours exactement au total.

## Structure

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

## Déploiement

Hébergé sur **Vercel** avec une base de données **Neon** (intégration). Le build exécute
`prisma generate && next build` — le schéma est appliqué délibérément avec
`prisma db push` (pas dans la CI). Deux environnements : **Production** (branche `main`) et
**Preview** (branches/PRs).

## Explorations de design

Le dossier [`design-samples/`](design-samples) contient 7 directions visuelles explorées
avant de retenir le rétro éditorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Ouvrez `index.html` pour les comparer.
