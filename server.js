const express = require('express');
const { execSync, exec } = require('child_process');
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
    const boundary = '----FB' + crypto.randomBytes(16).toString('hex');

    const headerParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${apiKey}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    ];

    const header = Buffer.from(headerParts.join(''));
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

    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
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
  const { slides, duration = 4 } = req.body;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvimfzimi';
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!slides || !Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: 'No slides provided. Send { slides: ["url1","url2",...] }' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    // Download images
    const imgPaths = [];
    for (let i = 0; i < slides.length; i++) {
      const imgPath = path.join(tmpDir, `slide${i}.jpg`);
      await new Promise((resolve, reject) => {
        const proto = slides[i].startsWith('https') ? https : require('http');
        const file = fs.createWriteStream(imgPath);
        proto.get(slides[i], (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            file.close();
            const redir = slides[i].startsWith('https') ? https : require('http');
            redir.get(response.headers.location, (r2) => {
              r2.pipe(file);
              file.on('finish', () => file.close(resolve));
            }).on('error', reject);
            return;
          }
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
      });
      imgPaths.push(imgPath);
    }

    // Build concat input file
    const concatFile = path.join(tmpDir, 'concat.txt');
    const lines = imgPaths.map(p => `file '${p}'\nduration ${duration}`).join('\n');
    fs.writeFileSync(concatFile, lines + `\nfile '${imgPaths[imgPaths.length - 1]}'`);

    // Generate video with audio
    execSync(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" ` +
      `-f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v libx264 -preset ultrafast -crf 28 ` +
      `-c:a aac -shortest ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
      `-threads 2 "${outputPath}"`,
      { stdio: 'pipe', timeout: 120000 }
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
    try { execSync(`rm -rf ${tmpDir}`); } catch(e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
