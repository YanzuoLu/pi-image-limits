import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_CODE_LIMITS, type ImageLimits, PI_DEFAULT_LIMITS, sizeImage } from "./resize.ts";
import {
	BYTE_CAP_HYSTERESIS,
	capImages,
	COUNT_DROP_BATCH,
	IMAGE_BYTE_CAP,
	MAX_IMAGES,
	MAX_IMAGES_1M_CONTEXT,
} from "./vendor/image-cap/cap.ts";

/** Claude Code's limits, tightened to the model's own so Pi's later normalization leaves the result alone. */
function imageLimits(ctx: ExtensionContext): ImageLimits {
	const model = { ...PI_DEFAULT_LIMITS, ...ctx.model?.inputLimits?.images?.resize };
	return {
		maxWidth: Math.min(CLAUDE_CODE_LIMITS.maxWidth, model.maxWidth),
		maxHeight: Math.min(CLAUDE_CODE_LIMITS.maxHeight, model.maxHeight),
		maxBytes: Math.min(CLAUDE_CODE_LIMITS.maxBytes, model.maxBytes),
	};
}

/** The format of the file `read` opened, which Pi may already have re-encoded into another one. */
async function fileMimeType(path: unknown, cwd: string): Promise<string | undefined> {
	if (typeof path !== "string") return undefined;
	const absolute = resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
	const file = await open(absolute).catch(() => undefined);
	if (!file) return undefined;
	try {
		const { buffer } = await file.read(Buffer.alloc(12), 0, 12, 0);
		if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
		if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
		if (buffer.toString("latin1", 1, 4) === "PNG") return "image/png";
		if (buffer.toString("latin1", 0, 4) === "GIF8") return "image/gif";
		return undefined;
	} finally {
		await file.close();
	}
}

const READ_NOTE = /^Read image file \[[^\]]*\]/;

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (!event.content.some((block) => block.type === "image")) return;
		const limits = imageLimits(ctx);
		const source = event.toolName === "read" ? await fileMimeType(event.input.path, ctx.cwd) : undefined;
		let changed = false;
		let sentType: string | undefined;
		const sized = event.content.map((block) => {
			if (block.type !== "image") return block;
			const next = sizeImage(block, source ?? block.mimeType, limits);
			sentType = next.mimeType;
			if (next === block) return block;
			changed = true;
			return { ...block, ...next };
		});
		if (!changed) return;
		// Pi's read note names the type it encoded; keep it naming the type actually sent.
		const content = sized.map((block) =>
			block.type === "text" && sentType && READ_NOTE.test(block.text)
				? { ...block, text: block.text.replace(READ_NOTE, `Read image file [${sentType}]`) }
				: block,
		);
		return { content };
	});

	pi.on("input", (event, ctx) => {
		if (!event.images?.length) return { action: "continue" };
		const limits = imageLimits(ctx);
		let changed = false;
		const images = event.images.map((image) => {
			const next = sizeImage(image, image.mimeType, limits);
			if (next === image) return image;
			changed = true;
			return { ...image, ...next };
		});
		return changed ? { action: "transform", text: event.text, images } : { action: "continue" };
	});

	// Claude Code's request budget, for every model: drop the oldest images in batches once a request
	// would carry too many of them or too many bytes of them.
	pi.on("context", (event, ctx) => {
		const model = ctx.model;
		const declared = model?.inputLimits;
		const messages = capImages(event.messages, {
			maxImages: Math.min(
				(model?.contextWindow ?? 0) > 200_000 ? MAX_IMAGES_1M_CONTEXT : MAX_IMAGES,
				declared?.images?.maxPerRequest ?? Number.POSITIVE_INFINITY,
			),
			dropBatch: COUNT_DROP_BATCH,
			byteCap: Math.min(IMAGE_BYTE_CAP, (declared?.maxRequestBytes ?? Number.POSITIVE_INFINITY) - 8 * 1024 * 1024),
			hysteresis: BYTE_CAP_HYSTERESIS,
		});
		if (messages !== event.messages) return { messages };
	});
}
