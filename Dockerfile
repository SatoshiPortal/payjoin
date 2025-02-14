
FROM rust:1.84.1-slim-bookworm AS base

RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update -y && \
    apt-get install -y \
        build-essential \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN git clone --branch payjoin-0.22.0 https://github.com/payjoin/rust-payjoin.git
WORKDIR /usr/src/rust-payjoin

COPY patches /usr/src/rust-payjoin/patches
RUN git apply patches/*

RUN cargo update -p cc --precise 1.0.105 && \
    cargo update -p regex --precise 1.9.6 && \
    cargo update -p reqwest --precise 0.12.4 && \
    cargo update -p url --precise 2.5.0 && \
    cargo update -p tokio --precise 1.38.1 && \
    cargo update -p tokio-util --precise 0.7.11 && \
    cargo update -p which --precise 4.4.0 && \
    cargo update -p zstd-sys --precise 2.0.8+zstd.1.5.5 && \
    cargo update -p clap_lex --precise 0.3.0 && \
    cargo update -p time --precise 0.3.20


FROM base AS builder-dev

RUN apt-get update && \
    apt-get install -y openssl && \
    rm -rf /var/lib/apt/lists/*

RUN cargo build --release -p payjoin-cli --features v2,_danger-local-https

RUN cd /tmp && \
    openssl req -x509 \
        -newkey rsa:2048 \
        -keyout /tmp/key.der \
        -out /tmp/localhost.der \
        -days 365 \
        -nodes \
        -subj "/CN=localhost" \
        -outform DER \
        -keyform DER && \
    chmod 600 /tmp/key.der && \
    chmod 644 /tmp/localhost.der


FROM base AS builder-prod

RUN cargo build --release -p payjoin-cli --features v2

FROM debian:bookworm-slim AS dev

RUN apt-get update && \
    apt-get install -y \
        procps \
        ncat \
        jq \
        lsof \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder-dev /usr/src/rust-payjoin/target/release/payjoin-cli /usr/local/bin/
COPY --from=builder-dev /tmp/key.der /tmp/
COPY --from=builder-dev /tmp/localhost.der /tmp/
COPY scripts /scripts
RUN chmod +x /scripts/*

EXPOSE 3000 3002 8000
CMD ["/scripts/start.sh"]


FROM debian:bookworm-slim AS prod

RUN apt-get update && \
    apt-get install -y \
        procps \
        ncat \
        jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder-prod /usr/src/rust-payjoin/target/release/payjoin-cli /usr/local/bin/
COPY scripts /scripts
RUN chmod +x /scripts/*

EXPOSE 3000 8000
CMD ["/scripts/start.sh"]