# FFmpeg Slideshow Generator

Converts 4 image URLs into an MP4 video slideshow. Free, unlimited, automated.

## Deploy to Railway (Free)

1. Go to https://railway.app and sign up (free)
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload this folder to a new GitHub repo first, OR use Railway CLI:

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

4. Railway gives you a public URL like: `https://your-app.railway.app`

## API Usage

### POST /generate

Send a POST request with the 4 image URLs:

```json
{
  "slide1": "https://hcti.io/v1/image/your-slide-1-id",
  "slide2": "https://hcti.io/v1/image/your-slide-2-id",
  "slide3": "https://hcti.io/v1/image/your-slide-3-id",
  "slide4": "https://hcti.io/v1/image/your-slide-4-id",
  "duration": 3
}
```

### Response

```json
{
  "success": true,
  "url": "https://file.io/xxxxx"
}
```

Use the `url` in Instagram → Publish a Reel → Video URL field in Make.com.

## Make.com Setup

1. After your 3 HTML/CSS to Image modules, add an **HTTP → Make a Request** module
2. URL: `https://your-app.railway.app/generate`
3. Method: POST
4. Body type: JSON
5. Body:
```json
{
  "slide1": "{{image_url_from_module_1}}",
  "slide2": "{{image_url_from_module_2}}",
  "slide3": "{{image_url_from_module_3}}",
  "slide4": "{{image_url_from_module_4}}",
  "duration": 3
}
```
6. Map the response `url` field to Instagram Reels → Video URL
