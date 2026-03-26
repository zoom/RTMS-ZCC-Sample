const express = require('express');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { securityHeaders } = require('./middleware/security');

const app = express();
const server = http.createServer(app);

const PORT = process.env.BACKEND_PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const FRONTEND_INTERNAL_URL = process.env.FRONTEND_INTERNAL_URL || FRONTEND_URL;

// Middleware - IMPORTANT: Order matters!
// 1. CORS must come FIRST
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Body parsers — capture raw body for webhook signature verification
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// 3. Security headers AFTER CORS
app.use(securityHeaders);

// Session configuration
if (!process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET is not set. Using an insecure fallback. Set SESSION_SECRET in your .env file before deploying.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Serve static frontend files (for production/ngrok deployment)
// Only serve static files if build directory exists (not in Docker dev mode)
const frontendBuildPath = path.join(__dirname, '../frontend/build');
const fs = require('fs');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug: Log all incoming requests to /api/webhooks/zoom
app.use('/api/webhooks/zoom', (req, _res, next) => {
  console.log('Webhook request received');
  next();
});

// Home endpoint - serves the React app (for Zoom Marketplace)
// In Docker mode, this redirects to root which is proxied to frontend
app.get('/api/home', (req, res) => {
  // Redirect to root - the proxy will handle serving the frontend
  res.redirect('/');
});

// OAuth: Authorize endpoint
app.get('/api/auth/authorize', (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  // Exchange code for tokens
  const tokenUrl = `${process.env.ZOOM_HOST || 'https://zoom.us'}/oauth/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: process.env.ZOOM_REDIRECT_URL || `${process.env.PUBLIC_URL}/api/auth/callback`
  });

  const authHeader = Buffer.from(
    `${process.env.ZOOM_APP_CLIENT_ID}:${process.env.ZOOM_APP_CLIENT_SECRET}`
  ).toString('base64');

  axios.post(tokenUrl, params.toString(), {
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
  .then(response => {
    const { access_token, refresh_token } = response.data;

    // Store tokens in session
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.save();

    res.json({ success: true, message: 'Authorization successful' });
  })
  .catch(error => {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to exchange authorization code',
      details: error.response?.data || error.message
    });
  });
});

// OAuth: Callback endpoint
app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const tokenUrl = `${process.env.ZOOM_HOST || 'https://zoom.us'}/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: process.env.ZOOM_REDIRECT_URL || `${process.env.PUBLIC_URL}/api/auth/callback`
    });

    const authHeader = Buffer.from(
      `${process.env.ZOOM_APP_CLIENT_ID}:${process.env.ZOOM_APP_CLIENT_SECRET}`
    ).toString('base64');

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token } = response.data;

    // Store tokens in session
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    await req.session.save();

    // Redirect back to app
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

// Verify x-zm-signature header on incoming Zoom webhooks
function verifyZoomWebhook(req) {
  const timestamp = req.headers['x-zm-request-timestamp'];
  const signature = req.headers['x-zm-signature'];

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const message = `v0:${timestamp}:${req.rawBody || ''}`;
  const hash = crypto
    .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN || 'your-secret-token')
    .update(message)
    .digest('hex');
  const expected = `v0=${hash}`;

  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Store recent webhook event signatures to prevent duplicates
const recentWebhooks = new Map();
const WEBHOOK_DEDUP_WINDOW_MS = 5000; // 5 seconds

// Webhook endpoint for Zoom events
app.post('/api/webhooks/zoom', async (req, res) => {
  if (!verifyZoomWebhook(req)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const { event, payload } = req.body;

  console.log('Webhook received:', event);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  // Handle URL validation
  if (event === 'endpoint.url_validation') {
    if (!payload?.plainToken) {
      return res.status(400).json({ error: 'Missing plainToken' });
    }

    const encryptedToken = crypto
      .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN || 'your-secret-token')
      .update(payload.plainToken)
      .digest('hex');

    return res.json({
      plainToken: payload.plainToken,
      encryptedToken
    });
  }

  // Forward RTMS events to RTMS server
  // The @zoom/rtms SDK creates its own webhook endpoint at the root path
  // Support both ZCC events (contact_center.voice_rtms_*) and regular meeting events
  const rtmsEvents = [
    'contact_center.voice_rtms_started',
    'contact_center.voice_rtms_stopped',
    'meeting.rtms_started',
    'meeting.rtms_stopped'
  ];

  if (rtmsEvents.includes(event)) {
    // Create unique signature for this webhook to detect duplicates
    const webhookSignature = `${event}:${payload.engagement_id || payload.rtms_stream_id}:${req.body.event_ts}`;

    // Check if we've recently processed this exact webhook
    if (recentWebhooks.has(webhookSignature)) {
      console.log(`Duplicate webhook detected (${webhookSignature}), skipping forward`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Mark this webhook as processed
    recentWebhooks.set(webhookSignature, Date.now());

    // Clean up old entries after dedup window
    setTimeout(() => {
      recentWebhooks.delete(webhookSignature);
    }, WEBHOOK_DEDUP_WINDOW_MS);

    const rtmsServerUrl = process.env.RTMS_SERVER_URL || 'http://localhost:8080';
    console.log(`Forwarding ${event} to RTMS server at ${rtmsServerUrl}`);
    axios.post(rtmsServerUrl, req.body, {
      headers: { 'Content-Type': 'application/json' }
    }).then(() => {
      console.log(`Successfully forwarded ${event} to RTMS server`);
    }).catch((error) => {
      console.error(`Failed to forward ${event} to RTMS server:`, error.message);
    });
  }

  res.status(200).json({ received: true });
});

// Proxy endpoint for Zoom API calls
app.all('/api/zoom/*', async (req, res) => {
  const accessToken = req.session.accessToken;

  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const zoomPath = req.path.replace('/api/zoom/', '');
  const zoomUrl = `https://api.zoom.us/v2/${zoomPath}`;

  try {
    const response = await axios({
      method: req.method,
      url: zoomUrl,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      data: req.body,
      params: req.query
    });

    res.json(response.data);
  } catch (error) {
    console.error('Zoom API proxy error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Zoom API request failed',
      details: error.response?.data || error.message
    });
  }
});

// Proxy all other requests to frontend React dev server (Docker mode)
// This allows the backend to serve as single entry point
app.use('/', createProxyMiddleware({
  target: FRONTEND_INTERNAL_URL,
  changeOrigin: true,
  ws: true, // Proxy websockets for React hot reload
  logLevel: 'silent',
  onError: (err, req, res) => {
    console.log('Proxy error:', err.message);
    res.writeHead(500, {
      'Content-Type': 'text/plain',
    });
    res.end('Frontend proxy error. Is the frontend container running?');
  }
}));

// Start server
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Frontend URL (OAuth redirects): ${FRONTEND_URL}`);
  console.log(`Frontend Internal URL (proxy): ${FRONTEND_INTERNAL_URL}`);
  console.log(`Public URL: ${process.env.PUBLIC_URL || 'http://localhost:3001'}`);
  console.log(`All requests to http://localhost:${PORT} are proxied to frontend at ${FRONTEND_INTERNAL_URL}`);
  console.log(`OAuth redirects go to: ${FRONTEND_URL}`);
  console.log(`API requests to /api/* are handled by this backend`);
});
