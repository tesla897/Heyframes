import express from 'express';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {cp, mkdir, readdir, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {buildCompositionHtml} from '../src/build-composition.js';
import {
  defaultExplainerDeckProps,
  defaultPaintExplainerChunkProps,
  getDefaultPropsForComposition,
  getSchemaForComposition,
} from '../src/schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const rendersDir = path.join(projectRoot, 'renders');
const tempRoot = path.join(projectRoot, '.tmp', 'jobs');

const port = Number(process.env.PORT || 3000);
const renderApiKey = process.env.RENDER_API_KEY?.trim() || '';
const alwaysUniqueFileNames = process.env.ALWAYS_UNIQUE_FILE_NAMES !== 'false';
const tempJobTtlSeconds = Number(process.env.TEMP_JOB_TTL_SECONDS || 86400);
const localRenderTtlSeconds = Number(process.env.LOCAL_RENDER_TTL_SECONDS || 0);
const hyperframesQuality = process.env.HYPERFRAMES_QUALITY?.trim() || 'standard';
const hyperframesWorkers = process.env.HYPERFRAMES_WORKERS?.trim() || '';
const s3Endpoint = process.env.S3_ENDPOINT_URL?.trim() || '';
const s3AccessKey = process.env.S3_ACCESS_KEY?.trim() || '';
const s3SecretKey = process.env.S3_SECRET_KEY?.trim() || '';
const s3BucketName = process.env.S3_BUCKET_NAME?.trim() || '';
const s3RegionValue = process.env.S3_REGION?.trim();
const s3Region = !s3RegionValue || s3RegionValue.toLowerCase() === 'none' ? 'us-east-1' : s3RegionValue;
const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';
const s3ObjectPrefix = (process.env.S3_OBJECT_PREFIX || 'heyframes-renders').replace(/^\/+|\/+$/g, '');
const s3SignedUrlTtlSeconds = Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 3600);
const storageEnabled = Boolean(s3Endpoint && s3AccessKey && s3SecretKey && s3BucketName);

const s3Client = storageEnabled
  ? new S3Client({
      endpoint: s3Endpoint,
      region: s3Region,
      forcePathStyle: s3ForcePathStyle,
      credentials: {
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
      },
    })
  : null;

const app = express();
app.use(express.json({limit: '10mb'}));

const getRequestApiKey = (req) => {
  const headerValue = req.get('x-api-key');
  if (headerValue) {
    return headerValue.trim();
  }

  const authHeader = req.get('authorization');
  if (!authHeader) {
    return '';
  }

  const [scheme, token] = authHeader.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return '';
  }

  return token.trim();
};

const requireRenderApiKey = (req, res, next) => {
  if (!renderApiKey) {
    next();
    return;
  }

  const providedKey = getRequestApiKey(req);
  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(renderApiKey);

  if (
    providedKey &&
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    message: 'Unauthorized',
    hint: 'Provide x-api-key or Authorization: Bearer <key>',
  });
};

const safeRemove = async (targetPath) => {
  if (!targetPath) {
    return;
  }

  try {
    await rm(targetPath, {force: true, recursive: true});
  } catch {
    // Best-effort cleanup.
  }
};

const cleanupDirectory = async (dirPath, maxAgeSeconds) => {
  if (!maxAgeSeconds || maxAgeSeconds <= 0) {
    return;
  }

  try {
    const cutoffMs = Date.now() - maxAgeSeconds * 1000;
    const entries = await readdir(dirPath, {withFileTypes: true});

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const entryStat = await stat(fullPath);
      if (entryStat.mtimeMs < cutoffMs) {
        await safeRemove(fullPath);
      }
    }
  } catch {
    // Best-effort cleanup.
  }
};

const ensureMp4Extension = (fileName) => {
  const parsed = path.parse(fileName || '');
  const ext = parsed.ext || '.mp4';
  return `${parsed.name || 'render'}${ext}`;
};

const resolveOutputFileName = (requestedFileName) => {
  const sanitized = ensureMp4Extension(String(requestedFileName || 'render.mp4').replace(/[^a-zA-Z0-9._-]/g, '-'));

  if (!alwaysUniqueFileNames) {
    return sanitized;
  }

  const parsed = path.parse(sanitized);
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${parsed.name}-${timestamp}-${suffix}${parsed.ext || '.mp4'}`;
};

const getOriginFromRequest = (req) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string' ? forwardedProto : req.protocol;
  return `${protocol}://${req.get('host')}`;
};

const getNpxCommand = () => {
  if (process.platform === 'win32') {
    return {command: 'cmd.exe', args: ['/c', 'npx.cmd']};
  }

  return {command: 'npx', args: []};
};

const writeJobProject = async ({jobDir, compositionId, props}) => {
  await mkdir(jobDir, {recursive: true});
  await cp(path.join(projectRoot, 'hyperframes.json'), path.join(jobDir, 'hyperframes.json'));
  await cp(path.join(projectRoot, 'DESIGN.md'), path.join(jobDir, 'DESIGN.md'));
  await writeFile(
    path.join(jobDir, 'meta.json'),
    JSON.stringify({id: `heyframes-${compositionId}`, name: `Heyframes ${compositionId}`}, null, 2),
    'utf8',
  );
  await writeFile(path.join(jobDir, 'index.html'), buildCompositionHtml({compositionId, props}), 'utf8');
};

const renderJob = ({jobDir, outputPath, fps}) =>
  new Promise((resolve, reject) => {
    const {command, args: baseArgs} = getNpxCommand();
    const args = [
      ...baseArgs,
      'hyperframes',
      'render',
      jobDir,
      '--output',
      outputPath,
      '--quality',
      hyperframesQuality,
      '--fps',
      String(fps),
      '--strict',
    ];

    if (hyperframesWorkers) {
      args.push('--workers', hyperframesWorkers);
    }

    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${projectRoot}${path.delimiter}${process.env.PATH || ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error('HyperFrames render failed');
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({stdout, stderr});
    });
  });

const getObjectKey = (fileName) => [s3ObjectPrefix, fileName].filter(Boolean).join('/');

const uploadRenderAndGetUrl = async ({fileName, filePath}) => {
  if (!s3Client) {
    return null;
  }

  const objectKey = getObjectKey(fileName);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3BucketName,
      Key: objectKey,
      Body: createReadStream(filePath),
      ContentType: 'video/mp4',
    }),
  );

  const signedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: s3BucketName,
      Key: objectKey,
      ResponseContentType: 'video/mp4',
      ResponseContentDisposition: `inline; filename="${fileName}"`,
    }),
    {expiresIn: s3SignedUrlTtlSeconds},
  );

  return {
    bucket: s3BucketName,
    key: objectKey,
    signedUrl,
  };
};

app.use('/renders', requireRenderApiKey, express.static(rendersDir));

app.get('/health', (_req, res) => {
  res.json({ok: true});
});

app.get('/sample-payload', (_req, res) => {
  res.json({
    explainerDeck: {compositionId: 'ExplainerDeck', props: defaultExplainerDeckProps, fileName: 'sample.mp4'},
    paintExplainerChunk: {
      compositionId: 'PaintExplainerChunk',
      props: defaultPaintExplainerChunkProps,
      fileName: 'paint-explainer-sample.mp4',
    },
  });
});

app.post('/render', requireRenderApiKey, async (req, res) => {
  await mkdir(rendersDir, {recursive: true});
  await mkdir(tempRoot, {recursive: true});
  await cleanupDirectory(tempRoot, tempJobTtlSeconds);
  await cleanupDirectory(rendersDir, localRenderTtlSeconds);

  const compositionId =
    req.body?.compositionId ||
    req.body?.props?.compositionId ||
    (Array.isArray(req.body?.props?.segments) ? 'PaintExplainerChunk' : 'ExplainerDeck');
  const props = req.body?.props ?? getDefaultPropsForComposition(compositionId);
  const schema = getSchemaForComposition(compositionId);

  if (!schema) {
    res.status(400).json({
      ok: false,
      message: `Unknown compositionId "${compositionId}"`,
    });
    return;
  }

  const parsedProps = schema.safeParse(props);
  if (!parsedProps.success) {
    res.status(400).json({
      ok: false,
      message: 'Invalid composition props',
      issues: parsedProps.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  const requestedFileName = req.body?.fileName || 'render.mp4';
  const safeName = resolveOutputFileName(requestedFileName);
  const outputPath = path.join(rendersDir, safeName);
  const jobDir = path.join(tempRoot, crypto.randomUUID());
  const fps = parsedProps.data.fps || (compositionId === 'PaintExplainerChunk' ? 24 : 30);

  try {
    await writeJobProject({jobDir, compositionId, props: parsedProps.data});
    const renderResult = await renderJob({jobDir, outputPath, fps});

    let url = `${getOriginFromRequest(req)}/renders/${safeName}`;
    let signedUrl = null;
    let storage = {mode: 'local'};
    let responseOutputPath = outputPath;

    if (storageEnabled) {
      const uploaded = await uploadRenderAndGetUrl({fileName: safeName, filePath: outputPath});
      url = uploaded.signedUrl;
      signedUrl = uploaded.signedUrl;
      storage = {
        mode: 's3',
        bucket: uploaded.bucket,
        key: uploaded.key,
        expiresInSeconds: s3SignedUrlTtlSeconds,
      };
      await safeRemove(outputPath);
      responseOutputPath = null;
    }

    await safeRemove(jobDir);

    res.json({
      ok: true,
      compositionId,
      requestedFileName,
      fileName: safeName,
      outputPath: responseOutputPath,
      url,
      signedUrl,
      storage,
      stdout: renderResult.stdout,
    });
  } catch (error) {
    await safeRemove(jobDir);
    await safeRemove(outputPath);
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      code: error?.code,
      stdout: error?.stdout,
      stderr: error?.stderr,
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ok: false, message: 'Not found'});
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Heyframes render service listening on :${port}`);
  console.log(`Render storage mode: ${storageEnabled ? 's3-signed-url' : 'local'}`);
  console.log(`Unique output names: ${alwaysUniqueFileNames ? 'enabled' : 'disabled'}`);
  console.log(`HyperFrames quality: ${hyperframesQuality}`);
  console.log(`HyperFrames workers: ${hyperframesWorkers || 'auto'}`);
  if (storageEnabled) {
    console.log(`S3 bucket: ${s3BucketName}`);
    console.log(`S3 object prefix: ${s3ObjectPrefix || '(root)'}`);
  }
});
