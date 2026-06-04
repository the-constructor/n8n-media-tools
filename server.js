const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');

const app = express();
const upload = multer({
  dest: '/tmp/uploads',
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

const API_KEY = process.env.MEDIA_API_KEY;

function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok'
  });
});

app.post('/image/metadata', auth, upload.single('file'), async (req, res) => {
  try {
    const meta = await sharp(req.file.path).metadata();

    res.json({
      width: meta.width,
      height: meta.height,
      format: meta.format,
      channels: meta.channels
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  } finally {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
});

app.post('/video/metadata', auth, upload.single('file'), async (req, res) => {
  execFile(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,codec_name',
      '-of',
      'json',
      req.file.path
    ],
    async (err, stdout) => {
      await fs.unlink(req.file.path).catch(() => {});

      if (err) {
        return res.status(500).json({
          error: err.message
        });
      }

      res.json(JSON.parse(stdout));
    }
  );
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Media Tools running on port 3000');
});
