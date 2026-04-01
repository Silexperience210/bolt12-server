# Stage 1: Build LNDK from source (supports amd64 + arm64)
FROM rust:1.85-slim AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    git \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone https://github.com/lndk-org/lndk.git . && \
    git checkout v0.3.0 && \
    cargo build --release --bin lndk

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/lndk /usr/local/bin/lndk

# Startup script: waits for LND before launching LNDK
COPY startup.sh /usr/local/bin/startup.sh
RUN chmod +x /usr/local/bin/lndk /usr/local/bin/startup.sh

EXPOSE 10010

ENTRYPOINT ["/usr/local/bin/startup.sh"]
