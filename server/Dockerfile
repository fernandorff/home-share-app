# Home Share server (spec 013). Build context = server/.
FROM rust:1.90-bookworm AS build
WORKDIR /w
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /w/target/release/home-share-server /usr/local/bin/home-share-server
ENV PORT=8080
EXPOSE 8080
CMD ["home-share-server"]
