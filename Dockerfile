# Home Share server (spec 013, task 5.2): the Rust API and the Vite web app in one image. Build context = repo root.
#   docker build -t home-share .            (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VITE_SENTRY_* as --build-arg: public values)
# No secrets here: DATABASE_URL, JWT_SECRET and the rest come from the host at run time (docs/specs/013-rust-server/design.md).

FROM node:24-bookworm-slim AS web
WORKDIR /w
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json postcss.config.mjs ./
COPY public public
COPY src src
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY VITE_SENTRY_DSN VITE_SENTRY_ENVIRONMENT VITE_SENTRY_TRACES_SAMPLE_RATE
RUN npm run build:web

FROM rust:1.90-bookworm AS server
WORKDIR /w
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src src
RUN cargo build --release

# glibc + libgcc only (the binary carries its own TLS roots); runs as a non-root user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /w/target/release/home-share-server /app/home-share-server
COPY --from=web /w/dist /app/dist
ENV PORT=8080 WEB_DIR=/app/dist
EXPOSE 8080
CMD ["/app/home-share-server"]
