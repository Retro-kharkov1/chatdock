# Build with Docker

Produces the installers from a clean machine with one command. The only thing you install is
Docker; the builder image carries Node.js, Wine (to build the Windows installer on Linux) and the
.NET SDK with GitVersion (for the version number).

| Target | Output (version `0.0.1-99` as an example) |
|---|---|
| `linux` | `Google-Chat-Desktop-0.0.1-99.AppImage`, `google-chat-desktop_0.0.1-99_amd64.deb`, `latest-linux.yml` |
| `win` | `Google Chat Desktop Setup 0.0.1-99.exe`, `...exe.blockmap`, `latest.yml` |
| `all` | both of the above (default) |

Everything lands in `release/` at the repository root (git-ignored). macOS is not built.

## Prerequisites

| Host | You need |
|---|---|
| Windows 10/11 | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL2 backend, started and showing "running". PowerShell 5.1 or 7. |
| Linux | Docker Engine 23 or newer (BuildKit is the default builder from 23.0), and a user allowed to run `docker` (member of the `docker` group). |
| macOS | Docker Desktop, bash. (Builds Linux and Windows artifacts, not a macOS app.) |

For every host: a **full git clone** (not a source zip, not a shallow clone, not a `git worktree`),
about 15 GB of free disk space (the image is about 7 GB) and internet access on the first run.
No Node.js, .NET or Wine on the host.

## Commands

Run from the repository root.

Windows (PowerShell):

```powershell
powershell -File scripts/docker-build.ps1 -Target all     # or: linux | win
```

Linux / macOS:

```bash
scripts/docker-build.sh all                                # or: linux | win
```

Options (both scripts): rebuild the image from scratch with `-RebuildImage` / `--rebuild-image`;
empty the download cache with `-CleanCache` / `--clean-cache`.

Environment overrides: `GCD_BUILDER_IMAGE` (image name, default `google-chat-desktop-builder:local`)
and `GCD_CACHE_VOLUME` (cache volume, default `gcd-builder-cache`).

Each run does, inside the container:

1. Copy the mounted repository into the container's own filesystem (without `node_modules/`,
   `release/`, `.env*`, key/certificate files, `spike/**/.profile`, `spike/**/out`).
2. Resolve the version with GitVersion from the copied git history.
3. `npm ci`, then `npm test`. A failing test stops the build; nothing is packaged.
4. `node scripts/build.js` for each target, the same entry point as `npm run dist` and CI. It checks
   that every produced file name and `latest*.yml` carries the version.
5. Copy the artifacts to `release/` and print their SHA-256 and sizes.

Typical timings on a modern laptop with a warm image: about 2 minutes for `linux`, 3.5 minutes for
`all` (the first run also downloads Electron and the builder tools into the cache volume). Pulling
the base image the first time takes a few minutes depending on your connection.

## How it is put together

- `build/docker/Dockerfile`: the builder image. Base `electronuserland/builder:24-wine-05.26`
  (the electron-builder maintainers' image: Node 24, Wine 11), plus the .NET SDK. Versions are
  `ARG`s at the top; bump them deliberately. The repository's `engines` field asks for Node 20 or
  newer, which Node 24 satisfies.
- `build/docker/entrypoint.sh`: the in-container driver described above.
- `scripts/docker-build.sh`, `scripts/docker-build.ps1`: one entry point per host OS. They build
  the image (cached after the first time), then run it with the repository mounted **read-only**
  at `/src`, `release/` at `/out` and a named volume `gcd-builder-cache` at `/cache`.
- The image does not contain the repository, and no secrets or `.env` files are copied in. The
  container runs as root (it is a short-lived tool and the source is read-only) and gives the files
  it writes to your user on Linux/macOS hosts.
- There is no `docker-compose.yml`: a single `docker run` with three mounts is all there is, and
  the scripts already select the target.

## Versioning

The version comes from **GitVersion only**, computed from the git history and tags exactly as in a
native build (`GitVersion.yml`, tool pinned in `dotnet-tools.json`). The container reads the
history from a copy of your repository's `.git`, so the result equals a native
`npm run dist` of the same commit. Uncommitted edits do not change it; they are built into the
artifacts, though.

There is no override and no fallback. If GitVersion cannot run (shallow clone, no `.git`) the build
stops with the reason. Without any tag the version is `0.0.1-<commits since start>`; a tag such as
`v0.1.0` makes that commit build as `0.1.0`. Details:
[packaging-release.md](../architecture/packaging-release.md), "Version flow".

## Unsigned installers

The Windows installer is **not code-signed**. Windows SmartScreen will show "Windows protected
your PC" the first time it is run: choose **More info**, then **Run anyway**. The Linux artifacts
are unsigned as well; auto-update checks rely on the checksums in `latest*.yml`. The log line
`signing with signtool.exe` that electron-builder prints during the Windows build is normal: with
no certificate configured, nothing is signed. Background:
[ADR-0003](../adr/0003-packaging-and-code-signing-approach.md).

Linux install-path details (`/opt/GoogleChatDesktop`, sandbox, dependencies) are in
[build-linux-in-docker.md](build-linux-in-docker.md).

## Native build (without Docker)

Needs Node.js 20 or newer and the .NET SDK (for GitVersion) on your PATH:

```
npm ci
npm test
npm run dist       # installer for the current OS into release/
```

An installer can only be built natively for the OS you are on (the Windows installer on Windows,
AppImage/deb on Linux); Docker is the way to build the other one.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot reach the Docker daemon` | Start Docker Desktop and wait for "running"; on Linux start the service and check `docker info` works without `sudo`. |
| Docker Desktop will not start on Windows | Enable WSL2 (`wsl --install`, reboot) and select "Use the WSL 2 based engine" in Docker Desktop settings. |
| Build is very slow or runs out of memory on Windows | Give the WSL2 VM more memory in `%UserProfile%\.wslconfig` (`[wsl2]` / `memory=8GB`), then `wsl --shutdown`. Keep the repository on a local drive. |
| `/src/.git is not a directory` | You are building from a source archive or a git worktree. Use a normal clone. |
| `the repository is a shallow clone` | `git fetch --unshallow --tags`. |
| `GitVersion could not produce a version` | Read the cause printed above it. The first run needs internet access to restore the GitVersion tool from nuget.org. |
| Files in `release/` owned by root (Linux) | You ran `docker run` by hand. Use `scripts/docker-build.sh`, which passes your uid/gid; fix existing files with `sudo chown -R "$USER" release`. |
| `permission denied` on `/var/run/docker.sock` | Add your user to the `docker` group and log in again. |
| SELinux host (Fedora/RHEL): `permission denied` reading `/src` | Add the `:z` option to the bind mounts in `scripts/docker-build.sh` (`-v "$REPO:/src:ro,z"`). |
| Stale or corrupt downloads | `scripts/docker-build.sh all --clean-cache` (or `-CleanCache`). |
| Image is stale after changing the Dockerfile or bumping an `ARG` | `--rebuild-image` / `-RebuildImage`. |
| Reclaim disk space | `docker rmi google-chat-desktop-builder:local` and `docker volume rm gcd-builder-cache`. |
| Git Bash on Windows | Use `scripts/docker-build.ps1`; the shell script is for Linux/macOS (or a WSL2 distro with Docker integration enabled). |

## Cache

The `gcd-builder-cache` volume holds npm packages, Electron and electron-builder downloads and
NuGet packages (about 250 MB). It is safe to delete; the next build downloads everything again.
