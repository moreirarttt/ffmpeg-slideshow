const express = require('express');
const puppeteer = require('puppeteer');
const cloudinary = require('cloudinary').v2;
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─────────────────────────────────────────────
// HELPER: Pick a random music file from music/
// ─────────────────────────────────────────────
function getRandomMusic() {
  const musicDir = path.join(__dirname, 'music');
  if (!fs.existsSync(musicDir)) return null;
  const files = fs.readdirSync(musicDir).filter(f => f.endsWith('.mp3'));
  if (!files.length) return null;
  const randomFile = files[Math.floor(Math.random() * files.length)];
  console.log(`Selected music: ${randomFile}`);
  return path.join(musicDir, randomFile);
}

// ─────────────────────────────────────────────
// EXISTING: HTML → Image (for carousel slides)
// ─────────────────────────────────────────────
app.post('/html-to-image', async (req, res) => {
  let browser;
  try {
    const { html, width = 1080, height = 1350 } = req.body;
    if (!html) return res.status(400).json({ error: 'HTML is required' });

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    const result = await cloudinary.uploader.upload(
      `data:image/png;base64,${screenshot.toString('base64')}`,
      { folder: 'appreciart-events' }
    );

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ─────────────────────────────────────────────
// SLIDESHOW: Image URL → MP4 with random music
// ─────────────────────────────────────────────
app.post('/slideshow', async (req, res) => {
  const { slides, duration = 15, audioUrl } = req.body;

  if (!slides || !slides.length) {
    return res.status(400).json({ error: 'slides array is required' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-'));
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    // Download the image
    const imageUrl = slides[0];
    const imagePath = path.join(tmpDir, 'slide.png');
    execSync(`curl -L -o "${imagePath}" "${imageUrl}"`, { timeout: 30000 });

    // Pick music: use provided audioUrl or pick random from music/ folder
    let musicPath = null;
    if (audioUrl) {
      musicPath = path.join(tmpDir, 'audio.mp3');
      execSync(`curl -L -o "${musicPath}" "${audioUrl}"`, { timeout: 30000 });
    } else {
      musicPath = getRandomMusic();
    }

    // Build FFmpeg command
    let ffmpegCmd;
    if (musicPath) {
      ffmpegCmd = `ffmpeg -loop 1 -i "${imagePath}" -i "${musicPath}" -c:v libx264 -t ${duration} -pix_fmt yuv420p -vf "scale=1080:1350" -c:a aac -b:a 128k -shortest -movflags +faststart -y "${outputPath}"`;
    } else {
      ffmpegCmd = `ffmpeg -loop 1 -i "${imagePath}" -c:v libx264 -t ${duration} -pix_fmt yuv420p -vf "scale=1080:1350" -movflags +faststart -y "${outputPath}"`;
    }

    execSync(ffmpegCmd, { timeout: 120000 });

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(outputPath, {
      resource_type: 'video',
      folder: 'appreciart-reels',
    });

    res.json({ url: result.secure_url, public_id: result.public_id });

  } catch (err) {
    console.error('Slideshow error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ─────────────────────────────────────────────
// NEW: HTML → Animated Video (for Reels)
// Records frames → FFmpeg → .mp4
// ─────────────────────────────────────────────
app.post('/html-to-video', async (req, res) => {
  let browser;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const outputPath = path.join(tmpDir, 'reel.mp4');
  const musicPath = getRandomMusic();

  try {
    const {
      html,
      width = 1080,
      height = 1350,
      duration = 6,
      fps = 30,
      music = true
    } = req.body;

    if (!html) return res.status(400).json({ error: 'HTML is required' });

    console.log('Launching Puppeteer for video...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    const animatedHtml = injectAnimations(html);
    await page.setContent(animatedHtml, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1000));

    const totalFrames = duration * fps;
    console.log(`Capturing ${totalFrames} frames at ${fps}fps...`);

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(tmpDir, `frame-${String(i).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png' });

      await page.evaluate((frameTime) => {
        document.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.animationName !== 'none') {
            el.style.animationDelay = `-${frameTime}s`;
          }
        });
      }, i / fps);
    }

    console.log('Assembling video with FFmpeg...');
    const framesPattern = path.join(tmpDir, 'frame-%05d.png');
    let ffmpegCmd;

    const hasMusicFile = music && musicPath && fs.existsSync(musicPath);

    if (hasMusicFile) {
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${framesPattern}" -i "${musicPath}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 22 -c:a aac -b:a 128k -shortest -movflags +faststart "${outputPath}"`;
    } else {
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${framesPattern}" -f lavfi -i "anullsrc=r=44100:cl=stereo" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 22 -c:a aac -b:a 128k -t ${duration} -movflags +faststart "${outputPath}"`;
    }

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err, stdout, stderr) => {
        if (err) { console.error('FFmpeg error:', stderr); reject(err); }
        else resolve();
      });
    });

    console.log('Uploading video to Cloudinary...');
    const result = await cloudinary.uploader.upload(outputPath, {
      resource_type: 'video',
      folder: 'appreciart-reels',
      format: 'mp4'
    });

    console.log('Video URL:', result.secure_url);
    res.json({ url: result.secure_url });

  } catch (error) {
    console.error('Video error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
});

// ─────────────────────────────────────────────
// INJECT ANIMATIONS into HTML
// ─────────────────────────────────────────────
function injectAnimations(html) {
  const animationCSS = `
    <style>
      @keyframes fadeUp {
        0%   { opacity: 0; transform: translateY(40px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes fadeIn {
        0%   { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes scaleIn {
        0%   { opacity: 0; transform: scale(0.92); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes slideRight {
        0%   { opacity: 0; transform: translateX(-30px); }
        100% { opacity: 1; transform: translateX(0); }
      }
      .title, [style*="font-weight:700"], [style*="font-weight:900"] {
        animation: fadeUp 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
        animation-delay: 0.2s;
      }
      .cat, .kicker, [style*="letter-spacing:8px"], [style*="letter-spacing:6px"] {
        animation: fadeIn 0.7s ease both;
        animation-delay: 0.05s;
      }
      .meta-block > div:nth-child(1) { animation: fadeUp 0.7s ease both; animation-delay: 0.5s; }
      .meta-block > div:nth-child(2) { animation: fadeUp 0.7s ease both; animation-delay: 0.7s; }
      .meta-block > div:nth-child(3) { animation: fadeUp 0.7s ease both; animation-delay: 0.9s; }
      .logo, img { animation: fadeIn 0.6s ease both; animation-delay: 0s; }
      .line { animation: scaleIn 0.5s ease both; animation-delay: 0.3s; transform-origin: left; }
      svg { animation: fadeIn 1.2s ease both; animation-delay: 0s; }
      .appreciart { animation: fadeIn 0.6s ease both; animation-delay: 1.1s; }
    </style>
  `;
  return html.replace('</head>', animationCSS + '</head>');
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', endpoints: ['/html-to-image', '/html-to-video', '/slideshow'] });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Endpoints: POST /html-to-image | POST /html-to-video | POST /slideshow`);
});
