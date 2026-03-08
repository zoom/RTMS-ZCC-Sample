import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import { saveRawAudio, convertRawToWav, closeRawStream, closeAllAudioStreams, makeSessionTimestamp, getChannelRawPath, getChannelWavPath, finalizeInterleavedWav } from './audioHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../.env') });

const PORT = process.env.PORT || 8080;
const CLIENT_ID = process.env.ZOOM_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_APP_CLIENT_SECRET;

// Ensure data directories exist
const dataDir = join(__dirname, 'data');
const audioDir = join(dataDir, 'audio');

[dataDir, audioDir].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Store active engagements
const activeEngagements = new Map();

// Generate signature: HMAC-SHA256(client_id + "," + engagement_id + "," + rtms_stream_id, secret)
function generateSignature(engagementId, rtmsStreamId) {
  const message = `${CLIENT_ID},${engagementId},${rtmsStreamId}`;
  return crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(message)
    .digest('hex');
}

// Connect to signaling WebSocket
function connectToSignalingWebSocket(engagementId, rtmsStreamId, serverUrl, engagementData) {
  const ws = new WebSocket(serverUrl);
  engagementData.signalingWs = ws;

  ws.on('open', () => {
    const handshake = {
      msg_type: 1,
      protocol_version: 1,
      engagement_id: engagementId,
      rtms_stream_id: rtmsStreamId,
      sequence: 0,
      signature: generateSignature(engagementId, rtmsStreamId)
    };

    ws.send(JSON.stringify(handshake));
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.msg_type === 2) {
      // Signaling handshake response
      if (message.status_code === 0) {
        const mediaUrl = message.media_server?.server_urls?.audio || message.media_server?.server_urls?.all;
        if (mediaUrl) {
          connectToMediaWebSocket(mediaUrl, engagementId, rtmsStreamId, ws, engagementData);
        }
      }
    } else if (message.msg_type === 6) {
      // Event subscription response
      console.log(message);
      if (message.event.event_type === 21) {
        console.log('transferred', message)
      }

    } else if (message.msg_type === 12) {
      // Keep-alive request
      ws.send(JSON.stringify({ msg_type: 13, timestamp: message.timestamp }));
    }
  });

  ws.on('error', (error) => {
    console.error(`Signaling WebSocket error:`, error.message);
  });

  ws.on('close', (code) => {
    console.log(`[${engagementId}] Signaling WebSocket closed (code: ${code})`);
    if (code === 1000) {
      console.log(`[${engagementId}] Transfer detected — reconnecting...`);
      if (engagementData.mediaWs) {
        engagementData.mediaWs.close();
        engagementData.mediaWs = null;
      }
      connectToSignalingWebSocket(engagementId, rtmsStreamId, engagementData.serverUrl, engagementData);
    }
  });
}

// Connect to media WebSocket
function connectToMediaWebSocket(mediaUrl, engagementId, rtmsStreamId, signalingWs, engagementData) {
  const ws = new WebSocket(mediaUrl);
  engagementData.mediaWs = ws;

  ws.on('open', () => {
    const handshake = {
      msg_type: 3,
      protocol_version: 1,
      engagement_id: engagementId,
      rtms_stream_id: rtmsStreamId,
      signature: generateSignature(engagementId, rtmsStreamId),
      media_type: 32, // Audio only
      payload_encryption: false,
      media_params: {
        audio: {
          content_type: 2, // RAW_AUDIO
          sample_rate: 1,  // 16kHz
          channel: 1,      // Mono
          codec: 1,        // L16
          data_opt: 1,     // Mixed stream
          send_rate: 20    // 20ms intervals
        }, 
        transcript: {
            content_type: 5,
            src_language: 9,
            enable_lid: true
        }
      }
    };

    ws.send(JSON.stringify(handshake));
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());

    if (message.msg_type === 4) {
      // Media handshake response
      if (message.status_code === 0) {
        // Send CLIENT_READY_ACK to signaling connection
        signalingWs.send(JSON.stringify({
          msg_type: 7,
          rtms_stream_id: rtmsStreamId
        }));

        // Subscribe to RTMS events
        signalingWs.send(JSON.stringify({
          msg_type: 5,
          rtms_stream_id: rtmsStreamId,
          events: [1, 2, 3, 4]
        }));
      }
    } else if (message.msg_type === 12) {
      // Keep-alive request
      ws.send(JSON.stringify({ msg_type: 13, timestamp: message.timestamp }));
    } else if (message.msg_type === 14) {
      // Audio data
      const audioBuffer = Buffer.from(message.content.data, 'base64');
      const channelId = message.content.channel_id;

      if (!engagementData.channelPaths.has(channelId)) {
        const rawPath = getChannelRawPath(engagementData.sessionDir, channelId);
        const wavPath = getChannelWavPath(engagementData.sessionDir, channelId);
        engagementData.channelPaths.set(channelId, { rawPath, wavPath });
        console.log(`🎙️  New channel ${channelId} → ${rawPath}`);
      } 


      const { rawPath } = engagementData.channelPaths.get(channelId);
      saveRawAudio(audioBuffer, rawPath);
      engagementData.audioChunkCount++;

      if (engagementData.audioChunkCount % 100 === 0) {
        console.log(`🎵 Audio chunks: ${engagementData.audioChunkCount} (channels: ${engagementData.channelPaths.size})`);
      }
    } else if(message.msg_type === 17){
        console.log("transcript", message.content.data)
      }
  });

  ws.on('error', (error) => {
    console.error(`Media WebSocket error:`, error.message);
  });

  ws.on('close', () => {
    // Media connection closed
  });
}

// Handle RTMS started webhook
function handleRTMSStarted(payload) {
  const { engagement_id, rtms_stream_id, server_urls } = payload;

  if (!engagement_id || !rtms_stream_id || !server_urls) {
    console.error('Invalid payload - missing required fields');
    return;
  }

  // Check for duplicate
  if (activeEngagements.has(engagement_id)) {
    return;
  }

  // Reserve this engagement_id immediately to prevent race condition
  activeEngagements.set(engagement_id, { reservedAt: new Date() });

  // Session directory named by recording start time
  const sessionDir = join(audioDir, makeSessionTimestamp());

  console.log(`🎙️  Recording session: ${sessionDir}`);
  console.log(`   Per-channel: channel_N.raw/.wav  |  Interleaved: mixed.wav`);

  // Store engagement data
  const engagementData = {
    engagementId: engagement_id,
    rtmsStreamId: rtms_stream_id,
    serverUrl: server_urls,
    sessionDir,
    channelPaths: new Map(), // channelId -> { rawPath, wavPath }
    audioChunkCount: 0,
    startedAt: new Date(),
    signalingWs: null,
    mediaWs: null
  };

  activeEngagements.set(engagement_id, engagementData);

  // Connect to signaling WebSocket
  try {
    connectToSignalingWebSocket(engagement_id, rtms_stream_id, server_urls, engagementData);
  } catch (error) {
    console.error(`Failed to connect:`, error.message);
    cleanupEngagement(engagement_id);
  }
}

// Handle RTMS stopped webhook
async function handleRTMSStopped(payload) {
  const { engagement_id } = payload;

  if (!engagement_id) {
    console.error('Invalid payload - missing engagement_id');
    return;
  }

  await cleanupEngagement(engagement_id);
}

// Cleanup engagement resources
async function cleanupEngagement(engagementId) {
  const data = activeEngagements.get(engagementId);

  if (!data) {
    return;
  }

  try {
    // Close WebSockets
    if (data.signalingWs) {
      data.signalingWs.close();
    }
    if (data.mediaWs) {
      data.mediaWs.close();
    }

    // Close each channel's raw stream and convert to WAV
    for (const [channelId, { rawPath, wavPath }] of data.channelPaths) {
      await closeRawStream(rawPath);
      await convertRawToWav(rawPath, wavPath);
      console.log(`  Channel ${channelId}: ${wavPath}`);
    }

    // Write interleaved stereo WAV from per-channel raw files
    await finalizeInterleavedWav(data.sessionDir, data.channelPaths);

    console.log('='.repeat(60));
    console.log('📁 Recording saved');
    console.log('='.repeat(60));
    console.log(`Session: ${data.sessionDir}`);
    console.log(`Channels: ${data.channelPaths.size}`);
    console.log(`Total chunks: ${data.audioChunkCount}`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error(`Cleanup error:`);
  } finally {
    activeEngagements.delete(engagementId);
  }
}

// Create Express app
const app = express();
app.use(express.json());

// Webhook endpoint
app.post('/', (req, res) => {
  const { event, payload } = req.body;

  if (event === 'contact_center.voice_rtms_started') {
    handleRTMSStarted(payload);
    res.status(200).json({ received: true });
  } else if (event === 'contact_center.voice_rtms_stopped') {
    handleRTMSStopped(payload);
    res.status(200).json({ received: true });
  } else {
    res.status(200).json({ received: true });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeEngagements: activeEngagements.size,
    engagements: Array.from(activeEngagements.keys())
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const [engagementId] of activeEngagements.entries()) {
    await cleanupEngagement(engagementId);
  }
  await closeAllAudioStreams();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log('ZCC RTMS Server');
  console.log('='.repeat(50));
  console.log(`Port: ${PORT}`);
  console.log(`Audio directory: ${audioDir}`);
  console.log('='.repeat(50));
  console.log('Server ready - waiting for webhooks');
});
