# syntax=docker/dockerfile:1
#
# BUG-10 reload acceptance runner (same toolchain as the BUG-11 paste runner): Electron on Linux under Xvfb. Toolchain only; the repository is mounted at run time.
FROM node:24-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth openssl ca-certificates dbus \
      libgtk-3-0 libnss3 libxss1 libxtst6 libasound2 libgbm1 libatk-bridge2.0-0 libatk1.0-0 \
      libdrm2 libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 libx11-xcb1 libnotify4 libsecret-1-0 libatspi2.0-0 libuuid1 \
 && rm -rf /var/lib/apt/lists/*
ENV npm_config_cache=/cache/npm ELECTRON_CACHE=/cache/electron npm_config_update_notifier=false
WORKDIR /work
HEALTHCHECK NONE
