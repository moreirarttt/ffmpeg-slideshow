const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { try { fs.unlinkSync(dest); } catch(e) {} reject(err); });
  });
}

function uploadToCloudinary(filePath, cloudName, apiKey, apiSecret, resourceType = 'image') {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHash('sha1')
      .update(`timestamp=${timestamp}${apiSecret}`).digest('hex');

    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----FB' + crypto.randomBytes(16).toString('hex');
    const ext = path.extname(filePath).replace('.', '');
    const mimeType = resourceType === 'video' ? 'video/mp4' : `image/${ext || 'png'}`;
    const headerParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${apiKey}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.${ext || 'png'}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ];
    const header = Buffer.from(headerParts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${cloudName}/${resourceType}/upload`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) resolve(parsed.secure_url);
          else reject(new Error(JSON.stringify(parsed)));
        } catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── HTML TO IMAGE ───────────────────────────────────────────────────────────
app.post('/html-to-image', async (req, res) => {
  const { html, width = 1080, height = 1350 } = req.body;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvimfzimi';
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!html) return res.status(400).json({ error: 'No html provided' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  const outputPath = path.join(tmpDir, 'output.png');

  try {
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: 'new',
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.screenshot({ path: outputPath, type: 'png', clip: { x: 0, y: 0, width, height } });
    await browser.close();

    if (apiKey && apiSecret) {
      const imageUrl = await uploadToCloudinary(outputPath, cloudName, apiKey, apiSecret, 'image');
      res.json({ url: imageUrl });
    } else {
      const imageBuffer = fs.readFileSync(outputPath);
      res.set('Content-Type', 'image/png');
      res.send(imageBuffer);
    }
  } catch (err) {
    console.error('html-to-image error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { execSync(`rm -rf ${tmpDir}`); } catch(e) {} 
  }
});

// ─── VIDEO GENERATE ──────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const { slides, duration = 4 } = req.body;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvimfzimi';
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!slides || !Array.isArray(slides) || slides.length === 0)
    return res.status(400).json({ error: 'No slides provided' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    const imgPaths = [];
    for (let i = 0; i < slides.length; i++) {
      const rawPath = path.join(tmpDir, `raw${i}.jpg`);
      const imgPath = path.join(tmpDir, `slide${i}.jpg`);
      await downloadFile(slides[i], rawPath);
      execSync(`ffmpeg -i "${rawPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:white" "${imgPath}"`, { stdio: 'pipe' });
      imgPaths.push(imgPath);
    }

    const n = imgPaths.length;
    const fadeDuration = 0.8;
    const fps = 30;
    let filterInputs = imgPaths.map((p) => `-loop 1 -t ${duration} -i "${p}"`).join(' ');
    let filterComplex = '';
    let lastOutput = '[0:v]';

    for (let i = 0; i < n - 1; i++) {
      const nextInput = `[${i + 1}:v]`;
      const outputLabel = i === n - 2 ? '[out]' : `[v${i}]`;
      const offset = (i + 1) * duration - fadeDuration;
      filterComplex += `${lastOutput}${nextInput}xfade=transition=fade:duration=${fadeDuration}:offset=${offset}${outputLabel};`;
      lastOutput = `[v${i}]`;
    }

    if (n === 1) filterComplex = '[0:v]copy[out]';

    execSync(
      `ffmpeg ${filterInputs} -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-filter_complex "${filterComplex}" -map "[out]" -map ${n}:a ` +
      `-c:v libx264 -preset ultrafast -crf 26 -c:a aac -shortest ` +
      `-pix_fmt yuv420p -movflags +faststart -r ${fps} "${outputPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );

    if (apiKey && apiSecret) {
      const videoUrl = await uploadToCloudinary(outputPath, cloudName, apiKey, apiSecret, 'video');
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
    try { execSync(`rm -rf ${tmpDir}`); } catch(e) {} 
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
