const express = require('express');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/generate', async (req, res) => {
  const { html, duration = 8 } = req.body;

  if (!html) {
    return res.status(400).json({ error: 'No HTML provided' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir);
  const outputPath = path.join(tmpDir, 'output.mp4');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const fps = 24;
    const totalFrames = duration * fps;
    const frameDelay = 1000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, `frame${String(i).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png' });
      await new Promise(r => setTimeout(r, frameDelay));
    }

    await browser.close();
    browser = null;

    execSync(
      `ffmpeg -framerate ${fps} -i ${framesDir}/frame%05d.png ` +
      `-c:v libx264 -preset ultrafast -crf 28 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-threads 1 ${outputPath}`,
      { stdio: 'pipe', timeout: 180000 }
    );

    const videoBuffer = fs.readFileSync(outputPath);
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="story.mp4"');
    res.send(videoBuffer);

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
