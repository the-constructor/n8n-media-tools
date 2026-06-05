const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');

const app = express();

const upload = multer({
  dest: '/tmp/uploads',
  limits: {
    fileSize: 300 * 1024 * 1024,
  },
});

const API_KEY = process.env.MEDIA_API_KEY;

function auth(req, res, next) {
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatio(width, height) {
  const divisor = gcd(width, height);
  return {
    ratio: width / height,
    label: `${width / divisor}:${height / divisor}`,
  };
}

function requireFile(req, res) {
  if (!req.file) {
    res.status(400).json({
      error: 'Missing file. Send multipart/form-data with field name "file".',
    });
    return false;
  }
  return true;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/version', async (req, res) => {
  execFile('ffmpeg', ['-version'], (err, stdout) => {
    res.json({
      status: 'ok',
      sharp: sharp.versions,
      ffmpeg: err ? false : stdout.split('\n')[0],
    });
  });
});

app.post('/image/metadata', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  try {
    const meta = await sharp(req.file.path).metadata();
    const ar = aspectRatio(meta.width, meta.height);

    res.json({
      type: 'image',
      width: meta.width,
      height: meta.height,
      aspectRatio: ar.ratio,
      aspectRatioLabel: ar.label,
      format: meta.format,
      channels: meta.channels,
      size: req.file.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/video/metadata', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  execFile(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,duration:stream_tags=rotate',
      '-of', 'json',
      req.file.path,
    ],
    async (err, stdout, stderr) => {
      await fs.unlink(req.file.path).catch(() => {});

      if (err) {
        return res.status(500).json({ error: stderr || err.message });
      }

      const parsed = JSON.parse(stdout);
      const stream = parsed.streams?.[0];

      if (!stream?.width || !stream?.height) {
        return res.status(422).json({ error: 'No video stream found' });
      }

      const rotation = Number(stream.tags?.rotate || 0);
      const displayWidth = Math.abs(rotation) === 90 || Math.abs(rotation) === 270
        ? stream.height
        : stream.width;
      const displayHeight = Math.abs(rotation) === 90 || Math.abs(rotation) === 270
        ? stream.width
        : stream.height;

      const ar = aspectRatio(displayWidth, displayHeight);

      res.json({
        type: 'video',
        width: stream.width,
        height: stream.height,
        displayWidth,
        displayHeight,
        aspectRatio: ar.ratio,
        aspectRatioLabel: ar.label,
        codec: stream.codec_name,
        duration: stream.duration ? Number(stream.duration) : null,
        rotation,
      });
    }
  );
});

app.post('/image/crop', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  const cropWidth = Number(req.body.cropWidth ?? req.query.cropWidth);
  const cropHeight = Number(req.body.cropHeight ?? req.query.cropHeight);
  const cropLeft = Number(req.body.cropLeft ?? req.query.cropLeft);
  const cropTop = Number(req.body.cropTop ?? req.query.cropTop);

  if (![cropWidth, cropHeight, cropLeft, cropTop].every(Number.isFinite)) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({
      error: 'Missing or invalid crop parameters',
      required: ['cropWidth', 'cropHeight', 'cropLeft', 'cropTop'],
    });
  }

  try {
    const meta = await sharp(req.file.path).metadata();

    if (
      cropLeft < 0 ||
      cropTop < 0 ||
      cropWidth <= 0 ||
      cropHeight <= 0 ||
      cropLeft + cropWidth > meta.width ||
      cropTop + cropHeight > meta.height
    ) {
      return res.status(400).json({
        error: 'Crop area outside image bounds',
        image: {
          width: meta.width,
          height: meta.height,
        },
        crop: {
          cropWidth,
          cropHeight,
          cropLeft,
          cropTop,
        },
      });
    }

    const outputBuffer = await sharp(req.file.path)
      .extract({
        left: Math.floor(cropLeft),
        top: Math.floor(cropTop),
        width: Math.floor(cropWidth),
        height: Math.floor(cropHeight),
      })
      .png()
      .toBuffer();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Width', String(Math.floor(cropWidth)));
    res.setHeader('X-Height', String(Math.floor(cropHeight)));
    res.send(outputBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Media Tools running on port 3000');
});
