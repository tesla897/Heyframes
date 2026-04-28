# Heyframes

A Coolify-friendly HyperFrames render service that speaks the same basic HTTP shape as the Remotion starter.

## Endpoints

- `GET /health`
- `GET /sample-payload`
- `POST /render`
- `GET /renders/<file>.mp4`

`/render` accepts:

```json
{
  "fileName": "sample.mp4",
  "compositionId": "ExplainerDeck",
  "props": {
    "slides": []
  }
}
```

or the n8n paint explainer shape:

```json
{
  "fileName": "chunk-1.mp4",
  "props": {
    "compositionId": "PaintExplainerChunk",
    "fps": 24,
    "width": 1280,
    "height": 720,
    "audioUrl": "https://example.com/voiceover.mp3",
    "logoUrl": "https://example.com/logo.jpg",
    "captions": {
      "words": []
    },
    "segments": []
  }
}
```

## Local

```bash
npm install
npm run render:sample
npm start
```

Then:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/sample-payload
```

Render the sample through the API:

```bash
curl -X POST http://localhost:3000/render \
  -H "Content-Type: application/json" \
  -d @sample-payload.json
```

## Coolify

1. Push this folder to a Git repository.
2. Create a Coolify app from the repository.
3. Select Dockerfile deployment.
4. Expose port `3000`.
5. Set environment variables as needed.

Useful env vars:

- `PORT=3000`
- `RENDER_API_KEY=your-secret-key`
- `HYPERFRAMES_QUALITY=standard`
- `HYPERFRAMES_WORKERS=2`
- `ALWAYS_UNIQUE_FILE_NAMES=true`
- `TEMP_JOB_TTL_SECONDS=86400`
- `LOCAL_RENDER_TTL_SECONDS=0`
- `S3_ENDPOINT_URL=https://your-minio-or-s3-endpoint`
- `S3_ACCESS_KEY=...`
- `S3_SECRET_KEY=...`
- `S3_BUCKET_NAME=heyframes-renders`
- `S3_REGION=us-east-1`
- `S3_FORCE_PATH_STYLE=true`
- `S3_OBJECT_PREFIX=heyframes-renders`
- `S3_SIGNED_URL_TTL_SECONDS=3600`

If `RENDER_API_KEY` is set, send either:

- `x-api-key: your-secret-key`
- `Authorization: Bearer your-secret-key`

## n8n Migration

Point the workflow render URL at this service:

```text
https://your-heyframes-domain/render
```

The response includes `url`, so the existing `Download Chunk` node can continue using `={{ $json.url }}`.
