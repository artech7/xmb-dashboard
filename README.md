# XMB Dashboard

A PS3 XrossMediaBar-inspired homelab dashboard. Animated nebula background, full keyboard and touch navigation, per-user preferences, admin-locked settings, and a single Docker container deployment.

![License](https://img.shields.io/github/license/artech7/xmb-dashboard)
![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fartech7%2Fxmb--dashboard-blue)

---

## Screenshots

> Desktop — XMB horizontal category bar with animated nebula background  
> Mobile — horizontal category pill strip with swipeable item cards  

---

## Features

### Interface
- **XMB layout** — horizontal category bar, vertical item list, smooth transitions
- **Animated nebula background** — drifting gas clouds, twinkling stars, per-category accent glow
- **Full keyboard navigation** — arrow keys for categories/items, Enter to open
- **Mobile responsive** — touch-friendly pill strip, swipe left/right to change category, tap to open
- **Browser tab title** — syncs with your dashboard title setting

### Customisation (no login required)
- **Preferences panel** — press `P` or Settings → Preferences
  - 6 nebula themes: Default · Crimson · Aurora · Stellar · Ember · Void
  - Background intensity: Dim / Normal / Vivid
  - Star density: Off / Normal / Dense
  - Font size: S / M / L
  - Show/hide service descriptions
  - Clock format: Auto / 12h / 24h
  - Animation speed: Normal / Slow / Off
- All preferences stored in `localStorage` — per-browser, instant, no save button

### Admin Panel (password protected)
- Add, rename, recolour, and reorder categories
- Add, edit, and remove services
- **Drag-to-reorder** services within a category
- **Icon picker** — search 400+ icons from the [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) repository, paste a URL, or upload your own image
- **Admin-only services** — hide individual services from non-admin users (filtered server-side)
- **Favicon editor** — set a custom favicon via URL or file upload
- Dashboard title and clock format settings

### Infrastructure
- **Single Docker container** — Node.js + Express backend
- **Persistent config** — saved to a Docker volume, survives restarts and image updates
- **JWT authentication** — 8-hour tokens, configurable secret
- **GitHub Actions** — auto-builds and pushes to `ghcr.io` on every push to `main`
- **Traefik-ready** — labels included in `docker-compose.yml`

---

## Category Icons

| Icon | Key | Icon | Key |
|---|---|---|---|
| 🌐 Network | `network` | 🎮 Gaming | `game` |
| 💾 Storage | `storage` | 🎵 Music | `music` |
| 🖥️ Server | `server` | 📷 Photos | `photo` |
| 📊 Monitor | `monitor` | 📚 Books | `book` |
| 🎬 Media | `media` | ☁️ Cloud | `cloud` |
| 💻 Code / Dev | `code` | 🛡️ Security | `security` |
| ⚙️ Settings | `settings` | 🏠 Smart Home | `home` |
| | | 🔧 Tools | `tools` |
| | | 🗄️ Database | `database` |
| | | ⌨️ Terminal | `terminal` |

---

## Quick Start

### Local (Node.js)
```bash
git clone https://github.com/artech7/xmb-dashboard.git
cd xmb-dashboard
npm install
node server.js
# Visit http://localhost:8484
```

### Docker (build locally)
```bash
docker compose up -d --build
# Visit http://localhost:8484
```

### Docker (pull from GitHub Container Registry)
```bash
# After first push, the GitHub Action builds the image automatically.
# In docker-compose.yml, swap the build: block for:
# image: ghcr.io/artech7/xmb-dashboard:latest
docker compose up -d
```

---

## Dockhand / Portainer Stack

1. Push this repo to GitHub (see below)
2. Wait for the GitHub Action to build the image (~1 min)
3. Make the package public: GitHub → Packages → `xmb-dashboard` → Package settings → Change visibility → Public
4. In Dockhand, create a stack with the `docker-compose.yml` contents
5. Set `image: ghcr.io/artech7/xmb-dashboard:latest` and remove the `build:` block
6. Set environment variables and deploy

**Updating:** Dockhand → Stacks → `xmb-dashboard` → **Pull & Restart**

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Admin panel password — **change before deploying** |
| `JWT_SECRET` | `xmb-change-this-secret` | Token signing secret — **change before deploying** |
| `PORT` | `8484` | Server listen port |

---

## docker-compose.yml

```yaml
version: "3.8"
services:
  xmb-dashboard:
    image: ghcr.io/artech7/xmb-dashboard:latest
    container_name: xmb-dashboard
    restart: unless-stopped
    ports:
      - "8484:8484"
    environment:
      - ADMIN_PASSWORD=yourpassword
      - JWT_SECRET=your-long-random-secret
      - PORT=8484
    volumes:
      - /volume1/docker/xmb:/app/data
    networks:
      - xmb-net
networks:
  xmb-net:
    driver: bridge
```

---

## Synology DSM Reverse Proxy

Control Panel → Login Portal → Advanced → Reverse Proxy → Create:

| Field | Value |
|---|---|
| Source protocol | HTTPS |
| Source hostname | `dash.yournas.local` |
| Source port | 443 |
| Destination protocol | HTTP |
| Destination hostname | `localhost` |
| Destination port | `8484` |

---

## Configuration

On first boot, `data/config.json` is seeded from `www/config.json`. All edits are made through the admin panel and saved back to the volume. The server automatically injects any missing system items (Preferences, Admin Panel) on startup.

### config.json structure
```json
{
  "title": "HOMELAB",
  "clockFormat": "24h",
  "favicon": "",
  "categories": [
    {
      "id": "network",
      "name": "Network",
      "icon": "network",
      "color": "#00c8ff",
      "items": [
        {
          "name": "Router",
          "url": "http://192.168.1.1",
          "desc": "Gateway / Admin UI",
          "icon": "router",
          "adminOnly": false
        }
      ]
    }
  ]
}
```

---

## Keyboard Shortcuts

### Dashboard
| Key | Action |
|---|---|
| `←` / `→` | Switch category |
| `↑` / `↓` | Select item |
| `Enter` | Open selected item |
| `P` | Open Preferences |

### Preferences panel
| Key | Action |
|---|---|
| `↑` / `↓` | Move between rows |
| `←` / `→` | Move between options |
| `Enter` / `Space` | Select option |
| `Esc` | Close |

### Mobile
| Gesture | Action |
|---|---|
| Swipe left / right | Switch category |
| Tap item | Open service |
| Tap category pill | Switch category |

---

## Admin Panel

Access via:
- Settings category → Admin Panel
- Direct URL: `http://yourhost:8484/admin`

Default password: `admin` — set via `ADMIN_PASSWORD` environment variable.

---

## Uploading to GitHub

```bash
cd xmb-dashboard
git remote add origin https://github.com/artech7/xmb-dashboard.git
git push -u origin main --force
```

After that, plain `git push` works for all future updates. The GitHub Action at `.github/workflows/docker.yml` builds and pushes the Docker image to `ghcr.io` automatically on every push to `main`.

---

## Project Structure

```
xmb-dashboard/
├── .github/
│   └── workflows/
│       └── docker.yml        # Auto-build → ghcr.io on push to main
├── data/
│   └── .gitkeep              # Runtime config saved here (gitignored)
├── www/
│   ├── index.html            # Full dashboard UI (XMB + settings + prefs)
│   ├── config.json           # Seed config — edit for defaults
│   ├── favicon.svg           # Default XMB favicon
│   └── favicon.png
├── .dockerignore
├── .gitignore
├── Dockerfile                # node:22-alpine
├── docker-compose.yml
├── package.json
├── README.md
└── server.js                 # Express: static files + config API + JWT auth
```

---

## License

MIT
