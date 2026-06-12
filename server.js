const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

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

const MEDIA_FORMATS = {
  VERTICAL_9_16: {
    key: 'vertical_9_16',
    label: '9:16',
    ratio: 9 / 16,
    image: { width: 1080, height: 1920 },
    video: { width: 1080, height: 1920 },
  },
  PORTRAIT_4_5: {
    key: 'portrait_4_5',
    label: '4:5',
    ratio: 4 / 5,
    image: { width: 1080, height: 1350 },
    video: { width: 1080, height: 1350 },
  },
  SQUARE_1_1: {
    key: 'square_1_1',
    label: '1:1',
    ratio: 1,
    image: { width: 1080, height: 1080 },
    video: { width: 1080, height: 1080 },
  },
  LANDSCAPE_16_9: {
    key: 'landscape_16_9',
    label: '16:9',
    ratio: 16 / 9,
    image: { width: 1200, height: 675 },
    video: { width: 1280, height: 720 },
  },
};

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatioLabel(width, height) {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function near(value, target, tolerance) {
  return Math.abs(value - target) <= tolerance;
}

function parseFps(value) {
  if (!value || value === '0/0') return null;

  const parts = String(value).split('/');

  if (parts.length !== 2) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);

  if (!denominator) return null;

  return Number((numerator / denominator).toFixed(3));
}

function normalizeRotation(value) {
  const raw = Number(value || 0);
  return ((raw % 360) + 360) % 360;
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr || err.message;
        return reject(err);
      }

      resolve(stdout);
    });
  });
}

function buildSocialMediaAnalysis({
  width,
  height,
  mimeType,
  fileName,
  fileSizeBytes,

  duration = null,
  fps = null,
  frameCount = null,
  codec = null,
  audioCodec = null,
  rotation = 0,
}) {
  const isVideo = duration !== null;
  const isImage = !isVideo;

  const ratio = width / height;
  const roundedRatio = Number(ratio.toFixed(4));

  const orientation =
    width === height
      ? 'square'
      : width > height
        ? 'landscape'
        : 'portrait';

  const isShortVideo =
    isVideo &&
    Number(duration) > 0 &&
    Number(duration) < 20;

  const rotatedMobileVideo =
    rotation === 90 ||
    rotation === 270;

  function detectFormatClass() {
    if (near(ratio, MEDIA_FORMATS.VERTICAL_9_16.ratio, 0.04)) return 'vertical_9_16';
    if (near(ratio, MEDIA_FORMATS.PORTRAIT_4_5.ratio, 0.04)) return 'portrait_4_5';
    if (near(ratio, MEDIA_FORMATS.SQUARE_1_1.ratio, 0.04)) return 'square_1_1';
    if (near(ratio, MEDIA_FORMATS.LANDSCAPE_16_9.ratio, 0.06)) return 'landscape_16_9';

    if (ratio < 0.5) return 'ultratall';
    if (ratio > 2.0) return 'ultrawide';
    if (ratio < 1) return 'portrait_custom';

    return 'landscape_custom';
  }

  const formatClass = detectFormatClass();

  let transformation = 'none';
  let transformMode = 'none';

  let recommendedWidth = width;
  let recommendedHeight = height;

  let targetAspectRatio = roundedRatio;
  let targetAspectRatioLabel = aspectRatioLabel(width, height);

  let cropWidth = width;
  let cropHeight = height;

  function setTarget(formatKey) {
    const preset = MEDIA_FORMATS[formatKey];

    recommendedWidth = isVideo
      ? preset.video.width
      : preset.image.width;

    recommendedHeight = isVideo
      ? preset.video.height
      : preset.image.height;

    targetAspectRatio = Number(preset.ratio.toFixed(4));
    targetAspectRatioLabel = preset.label;
  }

  if (formatClass === 'vertical_9_16') {
    setTarget('VERTICAL_9_16');
  }

  else if (formatClass === 'portrait_4_5') {
    setTarget('PORTRAIT_4_5');
  }

  else if (formatClass === 'square_1_1') {
    setTarget('SQUARE_1_1');
  }

  else if (
    formatClass === 'landscape_16_9' ||
    formatClass === 'landscape_custom'
  ) {
    setTarget('LANDSCAPE_16_9');
  }

  else if (formatClass === 'portrait_custom') {
    setTarget('PORTRAIT_4_5');
  }

  else if (formatClass === 'ultrawide') {
    transformation = 'crop';

    if (isImage) {
      transformMode = 'crop-to-16-9';
      setTarget('LANDSCAPE_16_9');

      cropWidth = Math.floor(height * MEDIA_FORMATS.LANDSCAPE_16_9.ratio);
      cropHeight = height;
    }

    else {
      transformMode = 'blur-background-to-16-9';
      setTarget('LANDSCAPE_16_9');
    }
  }

  else if (formatClass === 'ultratall') {
    transformation = 'crop';

    if (isImage) {
      transformMode = 'crop-to-4-5';
      setTarget('PORTRAIT_4_5');

      cropWidth = width;
      cropHeight = Math.floor(width / MEDIA_FORMATS.PORTRAIT_4_5.ratio);
    }

    else {
      transformMode = 'blur-background-to-9-16';
      setTarget('VERTICAL_9_16');
    }
  }

  const cropLeft = Math.floor((width - cropWidth) / 2);
  const cropTop = Math.floor((height - cropHeight) / 2);

  const normalizedCodec = (codec || '').toLowerCase();
  const normalizedAudioCodec = (audioCodec || '').toLowerCase();

  const needsReencode =
    isVideo &&
    (
      transformation === 'crop' ||
      (
        normalizedCodec &&
        normalizedCodec !== 'h264'
      ) ||
      (
        normalizedAudioCodec &&
        normalizedAudioCodec !== 'aac'
      )
    );

  const transformEndpoint =
    transformation === 'crop'
      ? `/${isVideo ? 'video' : 'image'}/crop`
      : null;

  function route({
    publish,
    destination = null,
    preferredFormat = null,
    outputWidth = null,
    outputHeight = null,
    reason = null,
    platformTransformation = transformation,
  }) {
    return {
      publish,
      destination,
      preferredFormat,
      transformation: platformTransformation,
      outputWidth,
      outputHeight,
      reason,
    };
  }

  function disabled(reason) {
    return route({
      publish: false,
      reason,
      platformTransformation: 'none',
    });
  }

  function enabled({
    destination,
    preferredFormat,
    outputWidth,
    outputHeight,
    reason = null,
    platformTransformation = transformation,
  }) {
    return route({
      publish: true,
      destination,
      preferredFormat,
      outputWidth,
      outputHeight,
      reason,
      platformTransformation,
    });
  }

  const platformRouting = {
    instagram: disabled('Format not recommended for Instagram'),
    facebook: disabled('Format not recommended for Facebook'),
    linkedin: disabled('Format not recommended for LinkedIn'),
    x: disabled('Format not recommended for X'),
    tiktok: disabled('Format not recommended for TikTok'),
  };

  const routes = {
    instagramFeed45: () => enabled({
      destination: 'feed',
      preferredFormat: '4:5',
      outputWidth: 1080,
      outputHeight: 1350,
    }),

    facebookFeed45: () => enabled({
      destination: 'feed',
      preferredFormat: '4:5',
      outputWidth: 1080,
      outputHeight: 1350,
    }),

    linkedinFeed45: () => enabled({
      destination: 'feed',
      preferredFormat: '4:5',
      outputWidth: 1080,
      outputHeight: 1350,
    }),

    instagramFeed169: () => enabled({
      destination: 'feed',
      preferredFormat: '16:9',
      outputWidth: 1080,
      outputHeight: 608,
    }),

    facebookFeed169: () => enabled({
      destination: 'feed',
      preferredFormat: '16:9',
      outputWidth: 1200,
      outputHeight: 630,
    }),

    linkedin169: () => enabled({
      destination: isVideo ? 'video' : 'feed',
      preferredFormat: '16:9',
      outputWidth: 1200,
      outputHeight: 630,
    }),

    x169: () => enabled({
      destination: isVideo ? 'video' : 'feed',
      preferredFormat: '16:9',
      outputWidth: isVideo ? 1280 : 1200,
      outputHeight: isVideo ? 720 : 675,
    }),

    square: (destination = 'feed') => enabled({
      destination,
      preferredFormat: '1:1',
      outputWidth: 1080,
      outputHeight: 1080,
    }),

    instagramReel: () => enabled({
      destination: 'reel',
      preferredFormat: '9:16',
      outputWidth: 1080,
      outputHeight: 1920,
    }),

    facebookReel: () => enabled({
      destination: 'reel',
      preferredFormat: '9:16',
      outputWidth: 1080,
      outputHeight: 1920,
    }),

    tiktokVideo: () => enabled({
      destination: 'video',
      preferredFormat: '9:16',
      outputWidth: 1080,
      outputHeight: 1920,
    }),
  };

  if (isImage) {
    if (
      formatClass === 'vertical_9_16' ||
      formatClass === 'portrait_4_5' ||
      formatClass === 'portrait_custom' ||
      formatClass === 'ultratall'
    ) {
      platformRouting.instagram = routes.instagramFeed45();
      platformRouting.facebook = routes.facebookFeed45();

      if (formatClass === 'portrait_4_5') {
        platformRouting.linkedin = routes.linkedinFeed45();
      }
    }

    if (formatClass === 'square_1_1') {
      platformRouting.instagram = routes.square();
      platformRouting.facebook = routes.square();
      platformRouting.linkedin = routes.square();
      platformRouting.x = routes.square();
    }

    if (
      formatClass === 'landscape_16_9' ||
      formatClass === 'landscape_custom' ||
      formatClass === 'ultrawide'
    ) {
      platformRouting.instagram = routes.instagramFeed169();
      platformRouting.facebook = routes.facebookFeed169();
      platformRouting.linkedin = routes.linkedin169();
      platformRouting.x = routes.x169();
    }
  }

  if (isVideo) {
    if (formatClass === 'vertical_9_16') {
      if (isShortVideo) {
        platformRouting.instagram = routes.instagramReel();
        platformRouting.facebook = routes.facebookReel();
      }

      else {
        platformRouting.instagram = enabled({
          destination: 'feed',
          preferredFormat: '4:5',
          outputWidth: 1080,
          outputHeight: 1350,
          reason: 'Video is 20s or longer, routed to feed instead of reel.',
        });

        platformRouting.facebook = enabled({
          destination: 'feed',
          preferredFormat: '4:5',
          outputWidth: 1080,
          outputHeight: 1350,
          reason: 'Video is 20s or longer, routed to feed instead of reel.',
        });
      }

      platformRouting.tiktok = routes.tiktokVideo();
    }

    if (
      formatClass === 'portrait_4_5' ||
      formatClass === 'portrait_custom'
    ) {
      platformRouting.instagram = routes.instagramFeed45();
      platformRouting.facebook = routes.facebookFeed45();
      platformRouting.linkedin = routes.linkedinFeed45();
    }

    if (formatClass === 'square_1_1') {
      platformRouting.instagram = routes.square();
      platformRouting.facebook = routes.square();
      platformRouting.linkedin = routes.square('video');
      platformRouting.x = routes.square('video');
    }

    if (
      formatClass === 'landscape_16_9' ||
      formatClass === 'landscape_custom' ||
      formatClass === 'ultrawide'
    ) {
      platformRouting.instagram = routes.instagramFeed169();
      platformRouting.facebook = routes.facebookFeed169();
      platformRouting.linkedin = routes.linkedin169();
      platformRouting.x = routes.x169();
    }

    if (formatClass === 'ultratall') {
      if (isShortVideo) {
        platformRouting.instagram = routes.instagramReel();
        platformRouting.facebook = routes.facebookReel();
      }

      else {
        platformRouting.instagram = enabled({
          destination: 'feed',
          preferredFormat: '4:5',
          outputWidth: 1080,
          outputHeight: 1350,
          reason: 'Video is 20s or longer, routed to feed instead of reel.',
        });

        platformRouting.facebook = enabled({
          destination: 'feed',
          preferredFormat: '4:5',
          outputWidth: 1080,
          outputHeight: 1350,
          reason: 'Video is 20s or longer, routed to feed instead of reel.',
        });
      }

      platformRouting.tiktok = routes.tiktokVideo();
    }
  }

  const publishTargets =
    Object.entries(platformRouting)
      .filter(([, value]) => value.publish)
      .map(([platform, value]) => ({
        platform,
        destination: value.destination,
        preferredFormat: value.preferredFormat,
        transformation: value.transformation,
        outputWidth: value.outputWidth,
        outputHeight: value.outputHeight,
      }));

  let contentStrategy = 'feed';

  if (isVideo && formatClass === 'vertical_9_16') {
    contentStrategy = isShortVideo ? 'shortVertical' : 'verticalFeed';
  }

  else if (formatClass === 'square_1_1') {
    contentStrategy = 'universalSquare';
  }

  else if (
    formatClass === 'landscape_16_9' ||
    formatClass === 'landscape_custom'
  ) {
    contentStrategy = 'landscapeProfessional';
  }

  else if (
    formatClass === 'portrait_4_5' ||
    formatClass === 'portrait_custom'
  ) {
    contentStrategy = 'portraitFeed';
  }

  else if (
    formatClass === 'ultrawide' ||
    formatClass === 'ultratall'
  ) {
    contentStrategy = 'needsTransform';
  }

  const recommendedProfile =
    publishTargets[0]?.destination || 'none';

  return {
    type: isVideo ? 'video' : 'image',

    width,
    height,
    ratio: roundedRatio,
    aspectRatio: roundedRatio,
    aspectRatioLabel: aspectRatioLabel(width, height),
    orientation,

    formatClass,
    contentStrategy,

    transformation,
    transformMode,
    transformEndpoint,

    cropWidth,
    cropHeight,
    cropLeft,
    cropTop,

    recommendedProfile,
    recommendedWidth,
    recommendedHeight,
    targetAspectRatio,
    targetAspectRatioLabel,

    isShortVideo,

    duration,
    fps,
    frameCount,

    codec: normalizedCodec || codec,
    audioCodec: normalizedAudioCodec || audioCodec,

    rotation,
    rotatedMobileVideo,

    needsReencode,

    platformRouting,
    publishTargets,

    mimeType,
    fileName,
    fileSizeBytes,
  };
}

app.post(
  '/media/analysis',
  auth,
  upload.single('file'),
  async (req, res) => {
    if (!requireFile(req, res)) {
      return;
    }

    const inputFile = req.file.path;

    try {
      const mimeType = req.file.mimetype || '';
      const isVideo = mimeType.startsWith('video/');

      if (!isVideo) {
        const meta = await sharp(inputFile).metadata();

        if (!meta.width || !meta.height) {
          return res.status(422).json({
            error: 'Image dimensions could not be detected',
          });
        }

        const analysis = buildSocialMediaAnalysis({
          width: meta.width,
          height: meta.height,
          mimeType,
          fileName: req.file.originalname,
          fileSizeBytes: req.file.size,
        });

        return res.json({
          ...analysis,
          format: meta.format,
          channels: meta.channels,
        });
      }

      const stdout = await execFilePromise('ffprobe', [
        '-v',
        'error',

        '-show_entries',
        'format=duration:stream=index,codec_type,width,height,codec_name,duration,avg_frame_rate,r_frame_rate,nb_frames:stream_tags=rotate:stream_side_data=rotation,side_data_type',

        '-of',
        'json',

        inputFile,
      ]);

      const parsed = JSON.parse(stdout);

      const videoStream =
        parsed.streams?.find((stream) =>
          stream.codec_type === 'video' &&
          stream.width &&
          stream.height
        );

      const audioStream =
        parsed.streams?.find((stream) =>
          stream.codec_type === 'audio'
        );

      if (!videoStream) {
        return res.status(422).json({
          error: 'No video stream found',
        });
      }

      const fps =
        parseFps(videoStream.avg_frame_rate) ||
        parseFps(videoStream.r_frame_rate);

      const duration =
        Number(videoStream.duration || 0) ||
        Number(parsed.format?.duration || 0) ||
        null;

      const frameCount =
        Number(videoStream.nb_frames || 0) ||
        (
          fps && duration
            ? Math.round(fps * duration)
            : null
        );

      const tagRotation =
        Number(videoStream.tags?.rotate || 0);

      const sideDataRotation =
        Number(
          videoStream.side_data_list?.find((item) =>
            typeof item.rotation !== 'undefined'
          )?.rotation || 0
        );

      const rawRotation =
        tagRotation || sideDataRotation || 0;

      const rotation =
        normalizeRotation(rawRotation);

      const isRotated90 =
        rotation === 90 ||
        rotation === 270;

      const displayWidth =
        isRotated90
          ? videoStream.height
          : videoStream.width;

      const displayHeight =
        isRotated90
          ? videoStream.width
          : videoStream.height;

      const analysis = buildSocialMediaAnalysis({
        width: displayWidth,
        height: displayHeight,

        duration,
        fps,
        frameCount,

        codec: videoStream.codec_name,
        audioCodec: audioStream?.codec_name,

        rotation,

        mimeType,
        fileName: req.file.originalname,
        fileSizeBytes: req.file.size,
      });

      return res.json({
        ...analysis,

        format: 'video',
        sourceWidth: videoStream.width,
        sourceHeight: videoStream.height,
        displayWidth,
        displayHeight,

        rawRotation,
        rotation,
      });
    }

    catch (e) {
      return res.status(500).json({
        error: e.message,
      });
    }

    finally {
      await fs.unlink(inputFile).catch(() => {});
    }
  }
);

app.post(
  '/image/crop',
  auth,
  upload.single('file'),
  async (req, res) => {
    if (!requireFile(req, res)) {
      return;
    }

    const startedAt = Date.now();
    const inputFile = req.file.path;

    try {
      const analysis = req.body.analysis
        ? JSON.parse(req.body.analysis)
        : null;

      let cropWidth = Number(req.body.cropWidth);
      let cropHeight = Number(req.body.cropHeight);
      let cropLeft = Number(req.body.cropLeft);
      let cropTop = Number(req.body.cropTop);

      let usedAnalysis = false;

      if (
        analysis &&
        analysis.type === 'image' &&
        analysis.transformation === 'crop'
      ) {
        cropWidth = Number(analysis.cropWidth);
        cropHeight = Number(analysis.cropHeight);
        cropLeft = Number(analysis.cropLeft);
        cropTop = Number(analysis.cropTop);
        usedAnalysis = true;
      }

      if (
        ![
          cropWidth,
          cropHeight,
          cropLeft,
          cropTop,
        ].every(Number.isFinite)
      ) {
        return res.status(400).json({
          error: 'Missing crop data',
          hint: 'Send analysis from /media/analysis or manual cropWidth/cropHeight/cropLeft/cropTop.',
        });
      }

      const meta = await sharp(inputFile).metadata();

      if (!meta.width || !meta.height) {
        return res.status(422).json({
          error: 'Image dimensions could not be detected',
        });
      }

      cropWidth = Math.floor(cropWidth);
      cropHeight = Math.floor(cropHeight);
      cropLeft = Math.floor(cropLeft);
      cropTop = Math.floor(cropTop);

      if (
        cropLeft < 0 ||
        cropTop < 0 ||
        cropWidth <= 0 ||
        cropHeight <= 0 ||
        cropLeft + cropWidth > meta.width ||
        cropTop + cropHeight > meta.height
      ) {
        return res.status(400).json({
          error: 'Crop outside image bounds',
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

      const isPng = meta.format === 'png';

      const outputExtension = isPng ? 'png' : 'jpg';
      const outputMimeType = isPng ? 'image/png' : 'image/jpeg';

      let pipeline = sharp(inputFile, {
        limitInputPixels: false,
        sequentialRead: true,
      }).extract({
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight,
      });

      let outputBuffer;

      if (isPng) {
        outputBuffer = await pipeline
          .png({
            compressionLevel: 6,
            adaptiveFiltering: false,
          })
          .toBuffer();
      }

      else {
        outputBuffer = await pipeline
          .jpeg({
            quality: 86,
            progressive: false,
            mozjpeg: false,
          })
          .toBuffer();
      }

      const processingMs = Date.now() - startedAt;

      const originalName = req.file.originalname || 'image';
      const baseName = originalName.replace(/\.[^/.]+$/, '');

      res.setHeader('Content-Type', outputMimeType);

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_${analysis?.transformMode || 'crop'}.${outputExtension}"`
      );

      res.setHeader('X-Processing-Ms', String(processingMs));
      res.setHeader('X-Used-Analysis', String(usedAnalysis));
      res.setHeader('X-Transformation', analysis?.transformation || 'manual-crop');
      res.setHeader('X-Transform-Mode', analysis?.transformMode || 'manual-crop');
      res.setHeader('X-Input-Width', String(meta.width));
      res.setHeader('X-Input-Height', String(meta.height));
      res.setHeader('X-Output-Width', String(cropWidth));
      res.setHeader('X-Output-Height', String(cropHeight));
      res.setHeader('X-Output-Mime-Type', outputMimeType);

      res.send(outputBuffer);
    }

    catch (e) {
      res.status(500).json({
        error: e.message,
      });
    }

    finally {
      await fs.unlink(inputFile).catch(() => {});
    }
  }
);

app.post('/video/crop', auth, upload.single('file'), async (req, res) => {
  if (!requireFile(req, res)) return;

  const startedAt = Date.now();

  const TMP_ROOT = '/tmp/media-tools';
  const MAX_AGE_MS = 2 * 60 * 60 * 1000;

  const inputFile = req.file.path;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const jobDir = path.join(TMP_ROOT, `job-${jobId}`);

  const frameFile = path.join(jobDir, 'midframe.jpg');
  const backgroundFile = path.join(jobDir, 'background.jpg');
  const outputFile = path.join(jobDir, 'output.mp4');

  async function cleanupOldTempDirs() {
    await fs.mkdir(TMP_ROOT, { recursive: true }).catch(() => {});

    const entries = await fs
      .readdir(TMP_ROOT, { withFileTypes: true })
      .catch(() => []);

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

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        args,
        { maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            err.message = stderr || err.message;
            return reject(err);
          }

          resolve({ stdout, stderr });
        }
      );
    });
  }

  try {
    await cleanupOldTempDirs();
    await fs.mkdir(jobDir, { recursive: true });

    const analysis = JSON.parse(req.body.analysis || '{}');

    if (analysis.type !== 'video') {
      return res.status(400).json({
        error: 'Invalid analysis. Expected analysis.type = "video".',
      });
    }

    if (analysis.transformation !== 'crop') {
      const stat = await fs.stat(inputFile);
      const processingMs = Date.now() - startedAt;

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Fast-Path', 'true');
      res.setHeader('X-Transformation', analysis.transformation || 'none');
      res.setHeader('X-Processing-Ms', String(processingMs));
      res.setHeader('X-Output-Size', String(stat.size));

      res.on('finish', async () => {
        await fs.unlink(inputFile).catch(() => {});
        await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      });

      return res.sendFile(inputFile);
    }

    const w = Number(analysis.recommendedWidth);
    const h = Number(analysis.recommendedHeight);
    const fps = Number(analysis.fps || 25);
    const duration = Number(analysis.duration || 0);
    const audioCodec = String(analysis.audioCodec || '').toLowerCase();

    if (![w, h, fps].every(Number.isFinite) || w <= 0 || h <= 0) {
      return res.status(400).json({
        error: 'Invalid analysis dimensions or fps',
        required: ['recommendedWidth', 'recommendedHeight', 'fps'],
      });
    }

    const outputFps = fps ? Math.min(30, fps) : 25;

    const midSecond =
      duration > 0
        ? Number((duration * 0.28).toFixed(3))
        : 0;

    const cpuCount = os.cpus().length;

    const serverProfile =
      req.body.serverProfile ||
      (
        cpuCount <= 4 ? 'small' :
        cpuCount <= 8 ? 'medium' :
        cpuCount <= 16 ? 'large' :
        'xlarge'
      );

    const profileConfig = {
      small: { preset: 'ultrafast', crf: 31 },
      medium: { preset: 'veryfast', crf: 29 },
      large: { preset: 'veryfast', crf: 27 },
      xlarge: { preset: 'fast', crf: 26 },
    };

    const config = profileConfig[serverProfile] || profileConfig.small;

    const threads = Math.min(
      12,
      Math.max(2, Math.floor(cpuCount * 0.7))
    );

    const frameStartedAt = Date.now();

    await runFfmpeg([
      '-y',
      '-ss', String(midSecond),
      '-i', inputFile,
      '-frames:v', '1',
      '-q:v', '4',
      frameFile,
    ]);

    const frameMs = Date.now() - frameStartedAt;

    const backgroundStartedAt = Date.now();

    await sharp(frameFile, {
      sequentialRead: true,
      limitInputPixels: false,
    })
      .resize({
        width: w,
        height: h,
        fit: 'cover',
        position: 'center',
      })
      .modulate({
        brightness: 0.5,
      })
      .blur(6)
      .jpeg({
        quality: 60,
        progressive: false,
        mozjpeg: false,
      })
      .toFile(backgroundFile);

    const backgroundMs = Date.now() - backgroundStartedAt;

    const encodingStartedAt = Date.now();

    let foregroundScaleFilter;

    if (analysis.transformMode === 'blur-background-to-16-9') {
      foregroundScaleFilter = `scale=${w}:-2,setsar=1`;
    }

    else if (analysis.transformMode === 'blur-background-to-9-16') {
      foregroundScaleFilter = `scale=-2:${h},setsar=1`;
    }

    else {
      foregroundScaleFilter =
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
    }

    const filterComplex =
      `[1:v]${foregroundScaleFilter}[fg];` +
      `[0:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]`;

    const audioArgs =
      audioCodec === 'aac'
        ? ['-c:a', 'copy']
        : ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'];

    await runFfmpeg([
      '-y',
      '-threads', String(threads),

      '-loop', '1',
      '-framerate', String(outputFps),
      '-i', backgroundFile,

      '-i', inputFile,

      '-filter_complex', filterComplex,

      '-map', '[v]',
      '-map', '1:a?',

      '-c:v', 'libx264',
      '-preset', config.preset,
      '-tune', 'fastdecode',
      '-crf', String(config.crf),
      '-bf', '0',
      '-refs', '1',
      '-pix_fmt', 'yuv420p',

      ...audioArgs,

      '-r', String(outputFps),
      '-shortest',

      outputFile,
    ]);

    const encodingMs = Date.now() - encodingStartedAt;
    const processingMs = Date.now() - startedAt;
    const stat = await fs.stat(outputFile);

    const originalName = req.file.originalname || 'video.mp4';
    const baseName = originalName.replace(/\.[^/.]+$/, '');

    res.setHeader('Content-Type', 'video/mp4');

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_${analysis.transformMode || 'video_crop'}.mp4"`
    );

    res.setHeader('X-Fast-Path', 'false');
    res.setHeader('X-Transformation', analysis.transformation || 'crop');
    res.setHeader('X-Transform-Mode', analysis.transformMode || '');
    res.setHeader('X-Server-Profile', serverProfile);
    res.setHeader('X-Threads', String(threads));
    res.setHeader('X-Preset', config.preset);
    res.setHeader('X-Crf', String(config.crf));

    res.setHeader('X-Frame-Extract-Ms', String(frameMs));
    res.setHeader('X-Background-Ms', String(backgroundMs));
    res.setHeader('X-Encoding-Ms', String(encodingMs));
    res.setHeader('X-Processing-Ms', String(processingMs));

    res.setHeader('X-Output-Width', String(w));
    res.setHeader('X-Output-Height', String(h));
    res.setHeader('X-Output-Fps', String(outputFps));
    res.setHeader('X-Output-Duration', String(duration));
    res.setHeader('X-Output-Size', String(stat.size));

    res.on('finish', async () => {
      await fs.unlink(inputFile).catch(() => {});
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    });

    res.sendFile(outputFile);
  }

  catch (e) {
    await fs.unlink(inputFile).catch(() => {});
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});

    res.status(500).json({
      error: e.message,
    });
  }
});

app.post(
  '/video/test-transform',
  auth,
  upload.single('file'),
  async (req, res) => {
    if (!requireFile(req, res)) {
      return;
    }

    const startedAt = Date.now();

    const inputFile = req.file.path;

    const format = String(
      req.body.format ||
      req.query.format ||
      ''
    ).toLowerCase();

    if (format !== 'wide' && format !== 'tall') {
      await fs.unlink(inputFile).catch(() => {});

      return res.status(400).json({
        error: 'Invalid format. Use format=wide or format=tall.',
      });
    }

    const TMP_ROOT = '/tmp/media-tools';
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const jobDir = path.join(TMP_ROOT, `test-${jobId}`);
    const outputFile = path.join(jobDir, `test-${format}.mp4`);

    function run(command, args) {
      return new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          {
            maxBuffer: 20 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) {
              err.message = stderr || err.message;
              return reject(err);
            }

            resolve({ stdout, stderr });
          }
        );
      });
    }

    function even(n) {
      return Math.floor(n / 2) * 2;
    }

    try {
      await fs.mkdir(jobDir, { recursive: true });

      const { stdout } = await run('ffprobe', [
        '-v',
        'error',

        '-select_streams',
        'v:0',

        '-show_entries',
        'stream=width,height,codec_name,duration,avg_frame_rate',

        '-of',
        'json',

        inputFile,
      ]);

      const parsed = JSON.parse(stdout);
      const stream = parsed.streams?.[0];

      if (!stream?.width || !stream?.height) {
        return res.status(422).json({
          error: 'No video stream found',
        });
      }

      const width = Number(stream.width);
      const height = Number(stream.height);

      let cropWidth;
      let cropHeight;
      let cropX;
      let cropY;
      let targetRatioLabel;

      if (format === 'wide') {
        // 21:9 by reducing height; crop must stay inside source bounds.
        cropWidth = width;
        cropHeight = Math.floor(width / (21 / 9));
        cropX = 0;
        cropY = Math.floor((height - cropHeight) / 2);
        targetRatioLabel = '21:9';
      }

      else {
        // 9:21 by reducing width; crop must stay inside source bounds.
        cropHeight = height;
        cropWidth = Math.floor(height * (9 / 21));
        cropX = Math.floor((width - cropWidth) / 2);
        cropY = 0;
        targetRatioLabel = '9:21';
      }

      cropWidth = even(cropWidth);
      cropHeight = even(cropHeight);
      cropX = even(Math.max(0, cropX));
      cropY = even(Math.max(0, cropY));

      if (
        cropWidth <= 0 ||
        cropHeight <= 0 ||
        cropX < 0 ||
        cropY < 0 ||
        cropX + cropWidth > width ||
        cropY + cropHeight > height
      ) {
        return res.status(400).json({
          error: 'Calculated crop is outside source bounds',
          source: {
            width,
            height,
          },
          crop: {
            cropWidth,
            cropHeight,
            cropX,
            cropY,
          },
        });
      }

      const cropFilter =
        `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},setsar=1`;

      await run('ffmpeg', [
        '-y',

        '-i',
        inputFile,

        '-vf',
        cropFilter,

        '-c:v',
        'libx264',

        '-preset',
        'ultrafast',

        '-crf',
        '30',

        '-bf',
        '0',

        '-refs',
        '1',

        '-pix_fmt',
        'yuv420p',

        '-c:a',
        'copy',

        '-movflags',
        '+faststart',

        outputFile,
      ]);

      const processingMs = Date.now() - startedAt;
      const stat = await fs.stat(outputFile);

      const originalName = req.file.originalname || 'test-video.mp4';
      const baseName = originalName.replace(/\.[^/.]+$/, '');

      res.setHeader('Content-Type', 'video/mp4');

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_${format}_${targetRatioLabel.replace(':', 'x')}.mp4"`
      );

      res.setHeader('X-Test-Transform', format);
      res.setHeader('X-Target-Ratio', targetRatioLabel);
      res.setHeader('X-Input-Width', String(width));
      res.setHeader('X-Input-Height', String(height));
      res.setHeader('X-Crop-Width', String(cropWidth));
      res.setHeader('X-Crop-Height', String(cropHeight));
      res.setHeader('X-Crop-X', String(cropX));
      res.setHeader('X-Crop-Y', String(cropY));
      res.setHeader('X-Output-Width', String(cropWidth));
      res.setHeader('X-Output-Height', String(cropHeight));
      res.setHeader('X-Processing-Ms', String(processingMs));
      res.setHeader('X-Output-Size', String(stat.size));

      res.on('finish', async () => {
        await fs.unlink(inputFile).catch(() => {});
        await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      });

      res.sendFile(outputFile);
    }

    catch (e) {
      await fs.unlink(inputFile).catch(() => {});
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});

      res.status(500).json({
        error: e.message,
      });
    }
  }
);

app.listen(3000, '0.0.0.0', () => {
  console.log('Media Tools running on port 3000');
});
