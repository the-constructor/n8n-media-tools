const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

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

function requireFile(req, res) {
  if (!req.file) {
    res.status(400).json({
      error: 'Missing file. Send multipart/form-data with field name "file".',
    });
    return false;
  }
  return true;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatioLabel(width, height) {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function buildSocialImageAnalysis({ width, height, mimeType, fileName, fileSizeBytes }) {
  const ratio = width / height;

  let orientation = 'square';
  if (width > height) orientation = 'landscape';
  if (height > width) orientation = 'portrait';

  const MIN_RATIO = 0.56;
  const MAX_RATIO = 1.91;

  const needsCrop = ratio < MIN_RATIO || ratio > MAX_RATIO;

  let targetRatio;
  let targetFormat;
  let target;

  if (ratio < 0.8) {
    targetRatio = 9 / 16;
    targetFormat = 'portrait 9:16';
    target = 'story';
  } else if (ratio < 1.0) {
    targetRatio = 4 / 5;
    targetFormat = 'portrait 4:5';
    target = 'feed';
  } else if (ratio < 1.2) {
    targetRatio = 1;
    targetFormat = 'square';
    target = 'feed';
  } else if (ratio < 1.4) {
    targetRatio = 4 / 3;
    targetFormat = 'landscape 4:3';
    target = 'feed';
  } else {
    targetRatio = Math.min(ratio, MAX_RATIO);
    targetFormat = 'landscape 16:9';
    target = 'feed';
  }

  let cropWidth = width;
  let cropHeight = height;

  if (ratio < MIN_RATIO) {
    cropHeight = Math.floor(width / MIN_RATIO);
  } else if (ratio > MAX_RATIO) {
    cropWidth = Math.floor(height * MAX_RATIO);
  }

  return {
    width,
    height,
    ratio: Number(ratio.toFixed(4)),
    aspectRatio: Number(ratio.toFixed(4)),
    aspectRatioLabel: aspectRatioLabel(width, height),
    orientation,

    instagramCompatible: ratio >= 0.56 && ratio <= 1.91,
    facebookCompatible: ratio >= 0.56 && ratio <= 1.91,
    linkedinCompatible: ratio >= 0.8 && ratio <= 1.91,
    xCompatible: ratio >= 0.56 && ratio <= 2.0,

    needsCrop,
    target,
    targetFormat,
    targetRatio: Number(targetRatio.toFixed(4)),

    cropWidth,
    cropHeight,
    cropLeft: Math.floor((width - cropWidth) / 2),
    cropTop: Math.floor((height - cropHeight) / 2),

    mimeType,
    fileName,
    fileSizeBytes,
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/version', (req, res) => {
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

    if (!meta.width || !meta.height) {
      return res.status(422).json({
        error: 'Image dimensions could not be detected',
      });
    }

    const result = buildSocialImageAnalysis({
      width: meta.width,
      height: meta.height,
      mimeType: req.file.mimetype,
      fileName: req.file.originalname,
      fileSizeBytes: req.file.size,
    });

    res.json({
      type: 'image',
      format: meta.format,
      channels: meta.channels,
      ...result,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/video/metadata', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  function parseFps(value) {
    if (!value || value === '0/0') return null;

    const parts = value.split('/');

    if (parts.length !== 2) {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);

    if (!denominator) return null;

    return Number((numerator / denominator).toFixed(3));
  }

  execFile(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=width,height,codec_name,duration,avg_frame_rate,r_frame_rate,nb_frames:stream_tags=rotate:stream_side_data=rotation,side_data_type',
      '-of', 'json',
      req.file.path,
    ],
    async (err, stdout, stderr) => {
      await fs.unlink(req.file.path).catch(() => {});

      if (err) {
        return res.status(500).json({ error: stderr || err.message });
      }

      try {
        const parsed = JSON.parse(stdout);
        const stream = parsed.streams?.[0];

        if (!stream?.width || !stream?.height) {
          return res.status(422).json({ error: 'No video stream found' });
        }

        const fps =
          parseFps(stream.avg_frame_rate) ||
          parseFps(stream.r_frame_rate);

        let frameCount = null;

        if (stream.nb_frames) {
          frameCount = Number(stream.nb_frames);
        } else if (fps && stream.duration) {
          frameCount = Math.round(fps * Number(stream.duration));
        }

        const tagRotation = Number(stream.tags?.rotate || 0);

        const sideDataRotation = Number(
          stream.side_data_list?.find((item) =>
            typeof item.rotation !== 'undefined'
          )?.rotation || 0
        );

        const rawRotation = tagRotation || sideDataRotation || 0;
        const rotation = ((rawRotation % 360) + 360) % 360;

        const isRotated90 = rotation === 90 || rotation === 270;

        const displayWidth = isRotated90 ? stream.height : stream.width;
        const displayHeight = isRotated90 ? stream.width : stream.height;

        const sourceRatio = stream.width / stream.height;

        const sourceIs16x9 =
          Math.abs(sourceRatio - 16 / 9) < 0.03 ||
          Math.abs(sourceRatio - 9 / 16) < 0.03;

        const rotatedMobile16x9Video =
          sourceIs16x9 &&
          isRotated90 &&
          stream.width > stream.height &&
          displayHeight > displayWidth;

        const result = buildSocialImageAnalysis({
          width: displayWidth,
          height: displayHeight,
          mimeType: req.file.mimetype,
          fileName: req.file.originalname,
          fileSizeBytes: req.file.size,
        });

        res.json({
          type: 'video',

          codec: stream.codec_name,
          duration: stream.duration ? Number(stream.duration) : null,

          fps,
          frameCount,
          avgFrameRate: stream.avg_frame_rate || null,
          realFrameRate: stream.r_frame_rate || null,

          sourceWidth: stream.width,
          sourceHeight: stream.height,
          sourceRatio: Number(sourceRatio.toFixed(4)),
          sourceAspectRatioLabel: aspectRatioLabel(stream.width, stream.height),

          displayWidth,
          displayHeight,

          rotation,
          rawRotation,
          isRotated90,
          rotationSource: tagRotation
            ? 'tag.rotate'
            : sideDataRotation
              ? 'side_data.rotation'
              : null,

          rotatedMobile16x9Video,

          ...result,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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
    res.setHeader('Content-Type', 'image/png');

    const originalName =
      req.file.originalname || 'image';
    
    const baseName = originalName.replace(/\.[^/.]+$/, '');
    
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_crop.png"`
    );
    
    res.send(outputBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/video/crop', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  const startedAt = Date.now();

  const TMP_ROOT = '/tmp/media-tools';
  const MAX_AGE_MS = 2 * 60 * 60 * 1000;

  const now = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  const jobDir = path.join(TMP_ROOT, `video-crop-${now}-${random}`);

  const inputFile = req.file.path;
  const frameFile = path.join(jobDir, 'midframe.jpg');
  const backgroundFile = path.join(jobDir, 'background.jpg');
  const outputFile = path.join(jobDir, 'output.mp4');

  function even(n) {
    return Math.floor(n / 2) * 2;
  }

  function run(command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.message = stderr || err.message;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async function cleanupOldTempDirs() {
    await fs.mkdir(TMP_ROOT, { recursive: true }).catch(() => {});
    const entries = await fs.readdir(TMP_ROOT, { withFileTypes: true }).catch(() => []);

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(TMP_ROOT, entry.name);
          const stat = await fs.stat(fullPath).catch(() => null);

          if (stat && Date.now() - stat.mtimeMs > MAX_AGE_MS) {
            await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
          }
        })
    );
  }

  try {
    await cleanupOldTempDirs();
    await fs.mkdir(jobDir, { recursive: true });

    const fps = Number(req.body.fps ?? req.query.fps);
    const frameCount = Number(req.body.frameCount ?? req.query.frameCount);
    const targetWidthRaw = Number(req.body.targetWidth ?? req.query.targetWidth);

    if (![fps, frameCount, targetWidthRaw].every(Number.isFinite)) {
      return res.status(400).json({
        error: 'Missing or invalid parameters',
        required: ['fps', 'frameCount', 'targetWidth'],
      });
    }

    const targetWidth = even(Math.min(1280, targetWidthRaw));
    const targetHeight = even(Math.round(targetWidth * 16 / 9));
    const outputFps = fps > 25 ? 25 : Math.max(1, Math.round(fps));

    const midFrame = Math.max(0, Math.round(frameCount * 0.28));
    const midSecond = Math.max(0, midFrame / fps);
    const outputDuration = Number((frameCount / fps).toFixed(3));

    await run('ffmpeg', [
      '-y',
      '-ss', String(midSecond),
      '-i', inputFile,
      '-frames:v', '1',
      '-q:v', '3',
      frameFile,
    ]);

    await sharp(frameFile)
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'cover',
        position: 'center',
        withoutEnlargement: false,
      })
      .modulate({ brightness: 0.6 })
      .blur(10)
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(backgroundFile);

    const fpsFilter = fps > 25 ? ',fps=25' : '';

    const filterComplex =
      `[1:v]scale='min(${targetWidth},iw)':'min(${targetHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2${fpsFilter}[fg];` +
      `[0:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]`;

    await run('ffmpeg', [
      '-y',
      '-threads', '2',

      '-loop', '1',
      '-framerate', String(outputFps),
      '-i', backgroundFile,

      '-i', inputFile,

      '-filter_complex', filterComplex,

      '-map', '[v]',
      '-map', '1:a?',

      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-pix_fmt', 'yuv420p',

      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',

      '-shortest',
      '-movflags', '+faststart',

      outputFile,
    ]);

    const processingMs = Date.now() - startedAt;
    const processingSeconds = Number((processingMs / 1000).toFixed(3));

    const originalName = req.file.originalname || 'video.mp4';
    const baseName = originalName.replace(/\.[^/.]+$/, '');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_9x16_overlay.mp4"`
    );

    res.setHeader('X-Processing-Ms', String(processingMs));
    res.setHeader('X-Processing-Seconds', String(processingSeconds));
    res.setHeader('X-Output-Width', String(targetWidth));
    res.setHeader('X-Output-Height', String(targetHeight));
    res.setHeader('X-Output-Fps', String(outputFps));
    res.setHeader('X-Output-Duration', String(outputDuration));

    res.on('finish', async () => {
      await fs.unlink(inputFile).catch(() => {});
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    });

    res.sendFile(outputFile);
  } catch (e) {
    await fs.unlink(inputFile).catch(() => {});
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Media Tools running on port 3000');
});
