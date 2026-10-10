# pi-image-limits

A [Pi](https://github.com/earendil-works/pi) extension that handles images the way Claude Code does, for every model and provider.

## Why

When Pi has to scale an image down, it encodes the result as PNG whenever that fits its per-image limit, whatever format the image came in. A JPEG photo or figure taller than 2000 pixels therefore leaves as a PNG of several megabytes instead of a JPEG of a few hundred kilobytes. A handful of those can carry a request past a provider's size limit, 32 MB at Anthropic, while the session's token count is still small, and compaction does not help because Pi counts each image as a fixed number of tokens.

## What it does

**Each image**, as it is read by a tool or attached to a prompt, follows Claude Code's sizing:

1. An image inside the limits, in the format it came in, is sent as is.
2. Otherwise it is fitted within 2000x2000 and encoded in its original format: JPEG and WebP stay, anything else becomes PNG.
3. If that is still too large, it is encoded as JPEG at quality 80, 60, 40 and 20, and as a last resort as JPEG 1000 pixels wide at quality 20.

The byte limit is Claude Code's 5 MB of base64, or the model's own image limit when that is smaller, so Pi's normalization afterwards leaves the result alone. Claude Code tries a palette PNG before falling back to JPEG; the image library Pi ships has no palette quantizer, so that step is skipped. JPEG output lays transparency over white.

**Each request** follows Claude Code's media budget: once a request would carry more than 24 MB of images, the oldest are dropped until it is under 14 MB, and past 100 images (600 on models with a context window over 200k) the oldest are dropped in a batch of 20. A model that declares a smaller request size or image count is held to that instead. Dropped images inside tool results become `[media removed: request limit]`; dropped prompt images are removed. The session file keeps every image, and dropping in batches keeps the request prefix, and with it the prompt cache, stable between trims. A session already stuck on an oversized request recovers on the next turn.

## Install

```sh
pi install git:github.com/YanzuoLu/pi-image-limits
```

## Development

```sh
npm install
npm run check
```

## Credits

The request budget is the trimming core of [pi-anthropic-image-cap](https://github.com/ogulcancelik/pi-extensions) by Can Celik (MIT), vendored unchanged in `src/vendor/image-cap` and applied here to every provider.

## License

MIT
