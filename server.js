const express = require('express');
const puppeteer = require('puppeteer');
const cloudinary = require('cloudinary').v2;
const app = express();

app.use(express.json({ limit: '10mb' }));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// HTML to Image endpoint
app.post('/html-to-image', async (req, res) => {
  let browser;
  try {
    const { html, width = 1080, height = 1350 } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'HTML is required' });
    }

    console.log('Launching Puppeteer...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    await page.waitForTimeout(2000);

    console.log('Taking screenshot...');
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    console.log('Uploading to Cloudinary...');
    const result = await cloudinary.uploader.upload(
      `data:image/png;base64,${screenshot.toString('base64')}`,
      { folder: 'appreciart-events' }
    );

    console.log('Image URL:', result.secure_url);
    res.json({ url: result.secure_url });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
