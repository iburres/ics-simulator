# OTForge Student Setup Guide

> **Tip:** For the best reading experience, [open the formatted version in your browser](https://iburres.github.io/otforge/student-setup.html).

Install three tools, clone the repository, and run a few commands. The whole process takes about 30–45 minutes (most of that is download time).

---

## System Requirements

| | Windows | macOS |
|---|---|---|
| **OS** | Windows 10 22H2 or later; Windows 11 | macOS 12 Monterey or later |
| **RAM** | 8 GB minimum (16 GB recommended) | 8 GB minimum (16 GB recommended) |
| **Disk** | 20 GB free | 20 GB free |
| **CPU** | 64-bit with virtualization enabled | Intel or Apple Silicon (M1/M2/M3/M4) |

> **Windows — verify virtualization is enabled:**
> Open Task Manager → Performance → CPU. Confirm "Virtualization: Enabled". If it says Disabled, ask your instructor for BIOS help before continuing.

---

## Step 1 — Install Docker Desktop

Go to **https://www.docker.com/products/docker-desktop** and download the installer for your platform.

> **Apple Silicon Mac (M1/M2/M3/M4):** Choose "Mac with Apple Silicon" — not the Intel version.
> To check: Apple menu → About This Mac. Look for "Chip" (Apple Silicon) or "Processor" (Intel).

Run the installer and launch Docker Desktop. Wait until the status shows **"Engine running"** (green indicator) before continuing.

Sign-in is not required — click "Continue without signing in" if prompted.

**Verify:**
```
docker --version
```

---

## Step 2 — Install Git

Go to **https://git-scm.com/downloads** and download the installer for your platform. Accept all defaults.

**Verify:**
```
git --version
```

---

## Step 3 — Install Node.js 22

Go to **https://nodejs.org** and download the **LTS** release. Make sure the major version is **22** — if the site shows a different version, click "Other Downloads" and select v22.

Run the installer and accept all defaults.

> **Node.js 20 will not work.** OTForge requires Node.js 22 or later.

**Verify:**
```
node --version
npm --version
```

---

## Step 4 — Clone OTForge

**Windows (PowerShell):**
```powershell
mkdir C:\OTForge
cd C:\OTForge
git clone https://github.com/iburres/otforge.git .
```

> **D:\ drive:** If your C:\ drive is full, use `D:\OTForge` instead — substitute `D:` for `C:` everywhere in this guide. All scripts auto-detect the drive they are run from.

**macOS (Terminal):**
```bash
mkdir ~/OTForge
cd ~/OTForge
git clone https://github.com/iburres/otforge.git .
```

> The `.` at the end of the `git clone` command clones into the current folder — do not omit it.

---

## Step 5 — Install and Launch

**Windows (PowerShell — from `C:\OTForge`):**

First, allow PowerShell scripts to run (one-time, your account only):
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
Type **Y** when prompted.

Then install and launch:
```powershell
npm install
npm run build:packages
npm run dev
```

---

**macOS (Terminal — from `~/OTForge`):**
```bash
npm install
npm run dev
```

---

OTForge will open. The first time you run a scenario and click **Start Simulation**, Docker will pull the required container images (~2–4 GB one-time download). This takes several minutes — subsequent launches are fast.

---

## Step 6 — Scenarios Folder

Your lab files (`.otflab`) go in:

| Platform | Path |
|---|---|
| Windows | `C:\OTForge\scenarios\` |
| macOS | `~/OTForge/scenarios/` |

This folder is created automatically when you clone the repository. When your instructor releases a lab file through Canvas, save it here.

---

## Getting Updates

Run these two commands from your OTForge folder — same on Windows and macOS:

```
git pull
npm run dev
```

That's it. `git pull` downloads the latest code and `npm run dev` installs any new dependencies and relaunches the app automatically.

---

## Troubleshooting

### "Docker Desktop is not running"
Open Docker Desktop and wait for the green "Engine running" status before launching OTForge.

### Docker Desktop hangs at "Starting Engine" (Windows)
This means the WSL 2 backend or the Docker service got stuck during installation or after an update. Try these steps in order:

1. **Quit Docker Desktop** — right-click the Docker whale icon in the system tray and choose **Quit Docker Desktop**.
2. **Restart WSL** — open PowerShell and run:
   ```powershell
   wsl --shutdown
   ```
3. **Relaunch Docker Desktop** — wait up to two minutes for the green "Engine running" indicator to appear.

If the spinner still does not clear:

4. Open **Task Manager** → **Services** tab → find **com.docker.service** → right-click → **Restart**.
5. Relaunch Docker Desktop.

If none of the above work, restart your computer and relaunch Docker Desktop. A full reboot clears stuck WSL instances and stalled service states.

### `npm run dev` fails — Electron not installed
```
npm install
npm run dev
```

### `TypeError: crypto.hash is not a function`
You are running Node.js 20. Uninstall it and install Node.js 22 from **https://nodejs.org**, then rerun from Step 5.

### Docker images fail to pull / EOF errors during simulation start
This is a network interruption — Docker's CDN dropped the connection mid-download. Click **Stop Simulation**, then **Start Simulation** again. Docker resumes interrupted downloads and usually succeeds on the second attempt.

If it keeps failing, try:
- Disconnecting from any VPN
- Switching to a different Wi-Fi network
- Signing in to Docker Hub (`docker login`) — authenticated pulls are more stable

### "Pool overlaps with other one on this address space"
A leftover Docker network from a previous session is blocking the new one. Remove stale networks:
```
docker network prune
```
Type `y` when prompted, then relaunch the simulation.

> **Prevention:** always click **Stop Simulation** in OTForge before closing the app.

### Windows — virtualization not enabled
Search your laptop model + "enable virtualization BIOS" for instructions specific to your hardware. Contact your instructor if you need help.

---

## Windows — Firewall Rule (Recommended)

When OTForge is running, Docker publishes lab ports to all network interfaces on Windows. Add a firewall rule to block them from being reachable by others on the same Wi-Fi.

Open **PowerShell as Administrator** and run:
```powershell
New-NetFirewallRule `
  -DisplayName "OTForge — Block inbound lab ports" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 1881,3000,3100,6800-6899,6900-6999,18080-18199 `
  -Action Block `
  -Profile Any
```

> **macOS:** Docker Desktop binds published ports to `127.0.0.1` (localhost only) by default — no firewall rule needed.

---

## Quick Reference

| Task | Windows | macOS |
|---|---|---|
| Open terminal | Start → PowerShell | Applications → Utilities → Terminal |
| Navigate to OTForge | `cd C:\OTForge` | `cd ~/OTForge` |
| Launch OTForge | `npm run dev` | `npm run dev` |
| Scenarios folder | `C:\OTForge\scenarios\` | `~/OTForge/scenarios/` |
| Get updates | `git pull` then `npm run dev` | `git pull` then `npm run dev` |


---

*Questions? Post in the course discussion board or bring your laptop to office hours.*
