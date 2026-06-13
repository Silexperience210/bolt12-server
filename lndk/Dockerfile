# Stage 1: Build LNDK from source (supports amd64 + arm64)
FROM rust:1.85-slim AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    git \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Pin the v0.3.0 release by commit hash for reproducible builds.
# Tag object: 70cd74061f6275970046112f2d5dc4df18fd89d8
# Commit:     b50e09c338b429dbd1eb26395e051b62ae30d71f
RUN git clone https://github.com/lndk-org/lndk.git . && \
    git checkout b50e09c338b429dbd1eb26395e051b62ae30d71f && \
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
