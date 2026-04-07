# Zoom Contact Center RTMS Basic Sample App

## Overview

This application uses Zoom RTMS captures live audio from Zoom Contact Center voice engagements. The app runs as a containerized microservices architecture with three main components:

- **Frontend**: React-based Zoom App SDK interface
- **Backend**: Express API server handling OAuth and webhooks
- **RTMS Server**: Real-time media stream processor for audio capture

## Features

- Real-time audio and transcript streams from Zoom Contact Center engagements 
- WAV file output for each stream (16kHz, 16-bit) + interleaved capability for muxing streams
- Auto-saving of streams, separated by channel id and engagement id 
- Docker containerization for easy deployment
- Duplicate webhook prevention


## Prerequisites

- Docker and Docker Compose
- Zoom Contact Center account with admin access
- RTMS license provisioned to your Contact Center account
- ngrok account (for exposing local server to Zoom webhooks)

## Docker Setup (reccomended path)

Docker handles all runtime dependencies — Node.js, npm, and ffmpeg are installed inside the containers. No local installation of those tools is required.

### 1. Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in your Zoom credentials (see [Application Variables](#application-variables) and [Zoom Marketplace Setup](#zoom-marketplace-setup) below).

### 2. Start the App

```bash
docker compose up
```

The services will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- RTMS Server: http://localhost:8080

### 3. Setup ngrok for Webhook Testing

In a new terminal:

```bash
ngrok http 3001
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`) into your `.env` wherever directed, then restart the containers to pick up the new values.

---

## Manual Setup (without Docker)

> Requires Node.js (latest LTS), npm, and ffmpeg installed locally.

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in your Zoom credentials, then set `FRONTEND_INTERNAL_URL` to `http://localhost:3000` (instead of the Docker service name).

### 3. Start All Services

```bash
npm run dev:local
```
**note: to use the above command, npm package (concurrently)[https://www.npmjs.com/package/concurrently] will need to be installed on local machine. 

### 4. Setup ngrok

```bash
ngrok http 3001
```

Copy the HTTPS URL into your `.env` file as `PUBLIC_URL` and `ZOOM_REDIRECT_URL`, then restart the services.

## Zoom Marketplace Setup

### 1. Create a New App

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/)
2. Click "Develop" > "Build App"
3. Select "General app" as the app type (note: app must user-managed)
4. Fill in basic information:
   - App name: Your app name
   - Redirect URL for OAuth: `https://your-ngrok-url.ngrok-free.app/api/auth/callback`
5. Create an event subscription under "Access": 
   - Toggle "Event Subscription" on 
   - Select "Webhook" for your method 
   - Add a name 
   - Under "Events" subscribe to all Contact Center RTMS events (search "ZCC" to quickly find and select)
   - Add in your notificiation URL to receive webhooks:`https://your-ngrok-url.ngrok-free.app/api/webhooks/zoom`
6. Surface your app for use within the Zoom Client under "Surface" (note: this sample app is specifically designed to be used as a Surface app): 
   - Add in your approved domains, including your home URL: 
      - Home URL: `https://your-ngrok-url.ngrok-free.app/api/home`
7. Add in app permissions under "Scopes": 
   - `contact_center:read:zcc_voice_audio`
   - `contact_center:update:engagement_rtms_app_status`
   - `contact_center:read:zcc_voice_transcript`

### 2. Configure App Credentials

In the "App Credentials" tab:

1. Note your **Client ID** and **Client Secret**
2. Add these to your `.env` file as:
   - `ZOOM_APP_CLIENT_ID`
   - `ZOOM_APP_CLIENT_SECRET`
3. Access and copy your **Secret Token** for event notifications in the "Access" menu. Add to `env` file as: 
   - `ZOOM_SECRET_TOKEN`


### 3. Add your app for use

Ensure your app is ready for use by adding it within the "Add your App -> Local Test" menu. Clicking "add app" will run through the OAuth process. Make sure your application is up and running. 

## Admin Set-up

Once your app is installed for use, you can configure it with your Contact Center settings at zoom.us/myhome: 

1. Navigate to "Admin -> Contact Center Management -> Integrations" 
2. Select "Zoom Apps", then the "RTMS" tab
3. Locate & select your newly created RTMS app to adjust settings
4. Ensure **auto-start** is enabled (this application is designed for use with auto-start *only*)
5. Add the app to the appropiate queue (note: voice engagements cannot access RTMS unless the user is assigned to a queue with app access) 

## Application Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ZOOM_APP_CLIENT_ID` | Client ID from Zoom Marketplace | `abc123xyz` |
| `ZOOM_APP_CLIENT_SECRET` | Client Secret from Zoom Marketplace | `secret123` |
| `ZOOM_SECRET_TOKEN` | Webhook secret token from Marketplace | `token123` |

### URL Configuration

| Variable | Description | Default | When to Update |
|----------|-------------|---------|----------------|
| `PUBLIC_URL` | Public backend URL for webhooks | `http://localhost:3001` | Update with ngrok URL |
| `ZOOM_REDIRECT_URL` | OAuth callback URL | `http://localhost:3001/api/auth/callback` | Update with ngrok URL |
| `FRONTEND_URL` | Frontend URL for redirects | `http://localhost:3000` | Keep as localhost |
| `FRONTEND_INTERNAL_URL` | Docker internal frontend URL | `http://frontend:3000` | Keep as Docker service |
| `RTMS_SERVER_URL` | RTMS server URL | `http://rtms:8080` | Keep as RTMS server |

### Port Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Frontend port | `3000` |
| `BACKEND_PORT` | Backend API port | `3001` |
| `RTMS_PORT` | RTMS server port | `3002` |

### Other Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `SESSION_SECRET` | Express session secret | Generate random string |


## Zoom for Government

If your organization uses **Zoom for Government** (ZoomGov), set the `ZOOM_HOST` environment variable to your GovCloud base URL:

```bash
ZOOM_HOST=https://us06web.zoom.us
```

This variable is used for all OAuth token exchange requests. All other configuration (webhook URLs, ngrok setup) remains the same. If `ZOOM_HOST` is not set, the app defaults to `https://zoom.us`.

## Application Flow

### 1. Engagement Starts

```
User receives call in Zoom Contact Center
         ↓
Zoom triggers webhook: contact_center.voice_rtms_started
         ↓
Backend receives webhook at /api/webhooks/zoom
         ↓
Backend forwards to RTMS server at http://rtms:8080
         ↓
RTMS server extracts engagement_id, rtms_stream_id, server_urls
```

### 2. RTMS Connection

```
RTMS server connects to Zoom signaling WebSocket
         ↓
Sends handshake with signature (HMAC-SHA256)
         ↓
Receives media server URL
         ↓
Connects to media WebSocket
         ↓
Sends media handshake (requests audio: 16kHz, mono, L16)
         ↓
Sends CLIENT_READY_ACK
```

### 3. Audio & Transcript Capture

```
RTMS server receives audio data messages (msg_type: 14)
         ↓
Extracts base64-encoded audio chunks by channel_id
         ↓
Decodes to PCM and appends to per-channel .raw file
         ↓
Files saved at: rtms/data/audio/{session_timestamp}/channel_N.raw

RTMS server receives transcript messages (msg_type: 17)
         ↓
Appends JSON transcript entry to daily log
         ↓
Saved at: rtms/data/transcripts/{YYYY-MM-DD}.txt
```

### 4. Engagement Ends

```
Zoom triggers webhook: contact_center.voice_rtms_stopped
         ↓
RTMS server closes WebSocket connections
         ↓
Each channel .raw file converted to channel_N.wav via ffmpeg
         ↓
Per-channel files interleaved into mixed.wav (stereo if 2 channels)
         ↓
Cleans up engagement resources
         ↓
Session directory ready: rtms/data/audio/{session_timestamp}/
```


## Data Storage

### Audio Files

Each engagement creates a timestamped session directory containing:

- **Location**: `rtms/data/audio/{YYYY-MM-DD_HH-MM-SS}/`
- **Per-channel raw**: `channel_N.raw` — raw 16-bit PCM captured during the call
- **Per-channel WAV**: `channel_N.wav` — individual mono WAV (16kHz, 16-bit) per participant
- **Mixed output**: `mixed.wav` — stereo interleaved WAV (L=channel 0, R=channel 1) when 2 channels; mono when 1 channel

### Transcript Files

- **Location**: `rtms/data/transcripts/`
- **Format**: Plain text, one JSON entry per line with ISO timestamp prefix
- **Naming**: `{YYYY-MM-DD}.txt` (one file per day)

### File Management

```bash
# Clean all audio files
npm run clean:data

# View session directories
ls -lh rtms/data/audio/

# Play mixed output (optional — requires ffplay installed locally)
ffplay rtms/data/audio/2024-01-15_10-30-45/mixed.wav

# View today's transcripts
cat rtms/data/transcripts/$(date +%Y-%m-%d).txt
```

## Development

### Docker (recommended)

```bash
# Start all services
docker compose up

# View logs
npm run logs

# View specific service logs
npm run logs:frontend
npm run logs:backend
npm run logs:rtms

# Rebuild containers after dependency changes
npm run rebuild

# Stop all services
docker compose down
```

### Local (without Docker)

> Requires Node.js (latest LTS), npm, and ffmpeg installed locally.

```bash
# Terminal 1: Start backend
cd backend && npm run dev

# Terminal 2: Start RTMS server
cd rtms && npm run dev

# Terminal 3: Start frontend
cd frontend && npm start

# Terminal 4: Start ngrok
ngrok http 3001
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start all services with Docker |
| `npm stop` | Stop all Docker containers |
| `npm run install:all` | Install dependencies for all services |
| `npm run dev:local` | Run all services locally (no Docker) |
| `npm run build` | Build frontend for production |
| `npm run logs` | View Docker logs |
| `npm run rebuild` | Rebuild and restart containers |
| `npm run clean` | Clean Docker volumes and cache |
| `npm run clean:data` | Delete all audio files |
| `npm run health` | Check backend health |
| `npm run ngrok` | Start ngrok tunnel |

## API Endpoints

### Backend (Port 3001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/home` | GET | App home (redirects to frontend) |
| `/api/auth/authorize` | GET | OAuth authorization |
| `/api/auth/callback` | GET | OAuth callback |
| `/api/webhooks/zoom` | POST | Zoom webhook handler |
| `/api/zoom/*` | ALL | Proxy to Zoom API |
| `/*` | ALL | Proxy to frontend |

### RTMS Server (Port 8080)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | RTMS webhook handler |
| `/health` | GET | Health check with active engagements |

## Known Limitations & Production Considerations

This is a sample application intended for development and demonstration purposes. The following patterns are intentional simplifications that **must be addressed before deploying to production**:

### Credential Storage
- **`.env` files are not production-ready.** Use a secrets manager such as [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/), [HashiCorp Vault](https://www.vaultproject.io/), or [GCP Secret Manager](https://cloud.google.com/secret-manager) to store `ZOOM_APP_CLIENT_ID`, `ZOOM_APP_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, and `SESSION_SECRET` in production.

### Session Storage
- **In-memory session store (`MemoryStore`) is used.** The `express-session` default store is explicitly [not designed for production](https://www.npmjs.com/package/express-session#compatible-session-stores) — it leaks memory and does not persist across restarts. Replace with a persistent store such as `connect-redis` or `connect-pg-simple`.

### State Management
- **Engagement state and webhook dedup tracking are held in process memory.** Active engagements (`activeEngagements`) and recent webhook signatures (`recentWebhooks`) are plain `Map` objects. All state is lost if the process restarts mid-call, and this approach does not support horizontal scaling. Use a shared store (Redis, a database) in production.

### Reliability
- **No retry or backoff logic.** If the RTMS server is temporarily unavailable when a webhook arrives, the event is silently dropped. Add a retry queue (e.g., Bull, BullMQ) for reliable delivery in production.
- **No WebSocket reconnection.** If the signaling or media WebSocket drops mid-call, the connection is not re-established. Implement reconnection logic with exponential backoff for production use.

### Rate Limiting
- **No rate limiting is applied to any endpoint.** Add rate limiting middleware (e.g., `express-rate-limit`) to the webhook and API endpoints before exposing them publicly.

### Transport Security
- **The server runs HTTP only.** TLS termination is handled externally (ngrok in development). In production, place the backend behind a TLS-terminating reverse proxy (nginx, AWS ALB, etc.) and enforce HTTPS.

### Error Handling
- **Some error responses include internal details** (Zoom API error bodies, internal error messages). Sanitize error responses in production to avoid leaking implementation details to clients.

