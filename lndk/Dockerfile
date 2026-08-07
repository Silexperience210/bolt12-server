# Stage 1: Build LNDK from source (supports amd64 + arm64)
FROM rust:1.88-slim AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    git \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Pinned to a master commit, NOT a tagged release.
#
# Why: amountless BOLT12 offers (needed for variable-amount payouts such as
# the OCEAN mining pool) require lndk PR #253, merged 2026-04-14. The last
# tagged release, v0.3.0 (2025-09-27, commit b50e09c), builds the offer with
# `.amount_msats(amount.unwrap_or(0))` unconditionally, which yields an
# offer_amount=0 offer — non-compliant with BOLT 12 (bolts #1316) and
# unpayable. PR #253 omits the field entirely when no amount is given:
#
#   if let Some(amount_msats) = args.amount_msats {
#       builder = builder.amount_msats(amount_msats);
#   }
#
# Revisit this pin once lndk cuts a release that contains PR #253.
#
# Merge commit: e0b23440a3a3c259122d0aefc1a5f4fd928b323e (master, 2026-04-14)
# Fix commit:   1b28412f6a9c ("fix: reject offers with offer_amount=0 per BOLT 12 spec")
# Previous pin: b50e09c338b429dbd1eb26395e051b62ae30d71f (v0.3.0)
#
# Note: master ships rust-toolchain.toml pinning Rust 1.88.0, hence the
# builder base image above.
RUN git clone https://github.com/lndk-org/lndk.git . && \
    git checkout e0b23440a3a3c259122d0aefc1a5f4fd928b323e && \
    cargo build --release --bin lndk

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    netcat-openbsd \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user for LNDK.
RUN groupadd -r lndk && \
    useradd -r -g lndk -m -d /home/lndk -s /sbin/nologin lndk && \
    mkdir -p /home/lndk/.lndk && \
    chown -R lndk:lndk /home/lndk

COPY --from=builder /build/target/release/lndk /usr/local/bin/lndk

# Startup script: waits for LND before launching LNDK
COPY startup.sh /usr/local/bin/startup.sh
RUN chmod +x /usr/local/bin/lndk /usr/local/bin/startup.sh

USER lndk

EXPOSE 10010

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD nc -z localhost 10010 || exit 1

ENTRYPOINT ["/usr/local/bin/startup.sh"]
