const express = require('express');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

function uploadToCloudinary(filePath, cloudName, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha1')
      .update(`timestamp=${timestamp}${apiSecret}`)
      .digest('hex');

    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${apiKey}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    ];

    const header = Buffer.from(parts.join('\r\n') + '\r\n');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${cloudName}/video/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) resolve(parsed.secure_url);
          else reject(new Error(JSON.stringify(parsed)));
        } catch (e) {
          reject(new Error(data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/generate', async (req, res) => {
  const { html, duration = 8 } = req.body;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvimfzimi';
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!html) return res.status(400).json({ error: 'No HTML provided' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir);
  const rawPath = path.join(tmpDir, 'raw.mp4');
  const outputPath = path.join(tmpDir, 'output.mp4');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const fps = 24;
    const totalFrames = duration * fps;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, `frame${String(i).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png' });
      await new Promise(r => setTimeout(r, 1000 / fps));
    }

    await browser.close();
    browser = null;

    // Generate video from frames
    execSync(
      `ffmpeg -framerate ${fps} -i ${framesDir}/frame%05d.png ` +
      `-c:v libx264 -preset ultrafast -crf 28 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-threads 1 ${rawPath}`,
      { stdio: 'pipe', timeout: 180000 }
    );

    // Add silent audio track (required by Instagram)
    execSync(
      `ffmpeg -i ${rawPath} -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v copy -c:a aac -shortest -movflags +faststart ${outputPath}`,
      { stdio: 'pipe', timeout: 60000 }
    );

    if (apiKey && apiSecret) {
      const videoUrl = await uploadToCloudinary(outputPath, cloudName, apiKey, apiSecret);
      res.json({ url: videoUrl });
    } else {
      const videoBuffer = fs.readFileSync(outputPath);
      res.set('Content-Type', 'video/mp4');
      res.send(videoBuffer);
    }

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
    try { execSync(`rm -rf ${tmpDir}`); } catch(e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
