# Game image for the RCT benchmark on Prime sandboxes.
# Holds: OpenRCT2 v0.5.5 (Linux), Node 20, our agent bridge, Xvfb (a pretend screen), ffmpeg (video),
# and, if given, the RCT2 game files. With RCT2 files inside, this image is PRIVATE: never publish it.
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git xz-utils unzip python3 \
        xvfb xdotool x11-utils ffmpeg \
        libsdl2-2.0-0 libpng16-16t64 libzip4t64 libcurl4t64 libfreetype6 libfontconfig1 \
        libicu74 libspeexdsp1 libflac12t64 libvorbisfile3 libssl3t64 zlib1g libgl1 libegl1 libduktape207 \
    && rm -rf /var/lib/apt/lists/*
# Extra trusted certificates, only for builds behind a company/cloud proxy (folder is empty otherwise)
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates

# Node 20 (official build, checksum-checked)
ARG NODE_VERSION=20.18.1
RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt | grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" | sha256sum -c - \
 && tar -xJf node-v${NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 \
 && rm node-v${NODE_VERSION}-linux-x64.tar.xz

# A normal user, so the game doesn't stop on its "running as admin" warning
RUN useradd -m -s /bin/bash player
USER player
WORKDIR /home/player

# Our bridge. setup.sh downloads the pinned OpenRCT2 v0.5.5 (checksum-checked), builds the plugin, runs the tests.
COPY --chown=player:player bridge/ /home/player/bridge/
RUN cd bridge && chmod +x scripts/*.sh && bash scripts/setup.sh

# RCT2 game files (the folder that has Data/g1.dat). Empty folder = headless-only test image.
COPY --chown=player:player rct2/ /opt/rct2/

COPY --chown=player:player --chmod=755 start-game.sh /home/player/start-game.sh
ENV DISPLAY=:99 SDL_AUDIODRIVER=dummy RCT2_PATH=/opt/rct2 BRIDGE=/home/player/bridge
CMD ["sleep", "infinity"]
