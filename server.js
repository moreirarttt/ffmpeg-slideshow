const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const crypto = require('crypto');
const app = express();

app.use(express.json({ limit: '10mb' }));

// Cloudinary upload function
function uploadToCloudinary(imageBuffer) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha256')
      .update(`timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
      .digest('hex');

    const formData = `------Boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\ndata:image/png;base64,${imageBuffer.toString('base64')}\r\n------Boundary\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}\r\n------Boundary\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${process.env.CLOUDINARY_API_KEY}\r\n------Boundary\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}\r\n------Boundary--\r\n`;

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=----Boundary',
        'Content-Length': Buffer.byteLength(formData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.secure_url) {
            resolve(result.secure_url);
          } else {
            reject(new Error('No URL in Cloudinary response'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(formData);
    req.end();
  });
}

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
    
    // Increased timeout and less strict waitUntil
    await page.setContent(html, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    
    // Wait a bit for fonts to load
    await page.waitForTimeout(2000);

    console.log('Taking screenshot...');
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    console.log('Uploading to Cloudinary...');
    const url = await uploadToCloudinary(screenshot);

    console.log('Image URL:', url);
    res.json({ url });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
