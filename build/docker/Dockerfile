# syntax=docker/dockerfile:1
#
# Self-contained builder for the Google Chat Desktop installers.
#
#   linux -> AppImage + deb (x64)
#   win   -> NSIS installer (x64), cross-built with Wine
#
# The image holds toolchains only. It does NOT contain the repository: the source is mounted
# read-only at run time (see scripts/docker-build.sh and scripts/docker-build.ps1 and
# docs/development/build-with-docker.md). The build context is this directory only.
#
# Base: the electron-builder maintainers' image with Node.js and Wine preinstalled
# (https://www.electron.build/docs/features/multi-platform-build/). Tag format is
# <node-major>-wine-<MM.YY>; the dated tag is a stable snapshot. Bump deliberately.
ARG BUILDER_TAG=24-wine-05.26
FROM electronuserland/builder:${BUILDER_TAG}

# .NET SDK: needed only to run the GitVersion tool pinned in the repo's dotnet-tools.json, so that
# the version is computed from git history inside the container exactly as in a native build.
# dotnet-install.sh verifies the checksum of the SDK archive it downloads.
ARG DOTNET_SDK_VERSION=10.0.401

ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    PATH=/usr/share/dotnet:${PATH}

RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --version "${DOTNET_SDK_VERSION}" --install-dir "${DOTNET_ROOT}" \
 && rm -f /tmp/dotnet-install.sh \
 && dotnet --version

# One cache volume (mounted at /cache by the host scripts) keeps downloads between runs:
# npm packages, Electron and electron-builder binaries, NuGet packages (GitVersion tool).
ENV npm_config_cache=/cache/npm \
    ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    NUGET_PACKAGES=/cache/nuget \
    npm_config_update_notifier=false

# The entrypoint may arrive with CRLF line endings from a Windows checkout; normalise it.
COPY entrypoint.sh /usr/local/bin/gcd-build
RUN sed -i 's/\r$//' /usr/local/bin/gcd-build && chmod 0755 /usr/local/bin/gcd-build

# Mount points: /src = repository (read-only), /out = host release/ folder, /cache = named volume.
# The container runs as root on purpose (it is a short-lived, network-listener-free build tool;
# the source is mounted read-only) and chowns what it writes to /out to HOST_UID:HOST_GID.
WORKDIR /project

# One-shot job: there is no long-running service to health-check.
HEALTHCHECK NONE

ENTRYPOINT ["/usr/local/bin/gcd-build"]
CMD ["all"]
