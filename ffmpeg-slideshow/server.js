const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TMP_DIR = '/tmp/slideshow';

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Download image from URL
async function downloadImage(url, filepath) {
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Generate slideshow video from image paths
function generateVideo(imagePaths, outputPath, duration = 3) {
  return new Promise((resolve, reject) => {
    // Build FFmpeg filter complex for slideshow with fade transitions
    const inputs = imagePaths.length;
    let filterComplex = '';
    let concatInputs = '';

    imagePaths.forEach((_, i) => {
      filterComplex += `[${i}:v]scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];`;
    });

    imagePaths.forEach((_, i) => {
      concatInputs += `[v${i}]`;
    });

    filterComplex += `${concatInputs}concat=n=${inputs}:v=1:a=0[outv]`;

    let cmd = ffmpeg();
    imagePaths.forEach((imgPath) => {
      cmd = cmd.input(imgPath).inputOptions([`-loop 1`, `-t ${duration}`]);
    });

    cmd
      .complexFilter(filterComplex, 'outv')
      .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart', '-r 30'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Upload to file.io (free temporary hosting)
async function uploadVideo(filepath) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath));
  form.append('expires', '1d');

  const response = await axios.post('https://file.io', form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return response.data.link;
}

// Main endpoint
app.post('/generate', async (req, res) => {
  const { slide1, slide2, slide3, slide4, duration = 3 } = req.body;

  if (!slide1 || !slide2 || !slide3 || !slide4) {
    return res.status(400).json({ error: 'Missing slide1, slide2, slide3, or slide4 URLs' });
  }

  const jobId = Date.now();
  const jobDir = path.join(TMP_DIR, String(jobId));
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    console.log(`[${jobId}] Downloading images...`);
    const slides = [slide1, slide2, slide3, slide4];
    const imagePaths = [];

    for (let i = 0; i < slides.length; i++) {
      const imgPath = path.join(jobDir, `slide${i + 1}.jpg`);
      await downloadImage(slides[i], imgPath);
      imagePaths.push(imgPath);
      console.log(`[${jobId}] Downloaded slide ${i + 1}`);
    }

    const outputPath = path.join(jobDir, 'slideshow.mp4');
    console.log(`[${jobId}] Generating video...`);
    await generateVideo(imagePaths, outputPath, duration);
    console.log(`[${jobId}] Video generated!`);

    console.log(`[${jobId}] Uploading video...`);
    const videoUrl = await uploadVideo(outputPath);
    console.log(`[${jobId}] Upload complete: ${videoUrl}`);

    // Cleanup
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({ success: true, url: videoUrl });
  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Slideshow generator running!' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
