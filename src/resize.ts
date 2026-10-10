import photon from "@silvia-odwyer/photon-node";

export interface EncodedImage {
	data: string;
	mimeType: string;
}

export interface ImageLimits {
	maxWidth: number;
	maxHeight: number;
	/** Limit on the base64-encoded size, as Pi measures it. */
	maxBytes: number;
}

/** Claude Code's per-image limits: 2000x2000 and 5 MB of base64. */
export const CLAUDE_CODE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 5 * 1024 * 1024 };

/** Pi's own limits when the model declares none (utils/image-resize-core.js). */
export const PI_DEFAULT_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

const JPEG_QUALITIES = [80, 60, 40, 20];
const LAST_RESORT_WIDTH = 1000;
const LAST_RESORT_QUALITY = 20;

type Format = "jpeg" | "png" | "webp";

/** The format Claude Code keeps an image in: JPEG and WebP stay, everything else becomes PNG. */
export function keptFormat(mimeType: string): Format {
	const subtype = mimeType.split("/")[1]?.toLowerCase();
	return subtype === "jpeg" || subtype === "jpg" ? "jpeg" : subtype === "webp" ? "webp" : "png";
}

const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * Claude Code's image sizing on Photon. An image inside the limits and already in the format it came in is sent
 * as is. Otherwise it is fitted within the dimensions and encoded in its original format; if that is still too
 * large, as JPEG at quality 80, 60, 40 and 20, and as a last resort as JPEG 1000 pixels wide at quality 20.
 * Claude Code first tries a palette PNG for oversized PNG; Photon has no palette quantizer, so that step is
 * skipped. JPEG output lays transparency over white, since JPEG has no alpha channel.
 *
 * `sourceFormat` is the format the image was read in, which differs from `image` when Pi has already re-encoded
 * it; the result keeps the source format as Claude Code would.
 */
export function sizeImage(image: EncodedImage, sourceMimeType: string, limits: ImageLimits): EncodedImage {
	const format = keptFormat(sourceMimeType);
	const bytes = Buffer.from(image.data, "base64");
	const decoded = photon.PhotonImage.new_from_byteslice(bytes);
	try {
		const width = decoded.get_width();
		const height = decoded.get_height();
		const inside = width <= limits.maxWidth && height <= limits.maxHeight;
		if (inside && base64Size(bytes.byteLength) < limits.maxBytes && keptFormat(image.mimeType) === format) {
			return image;
		}
		let fitWidth = width;
		let fitHeight = height;
		if (fitWidth > limits.maxWidth) {
			fitHeight = Math.round((fitHeight * limits.maxWidth) / fitWidth);
			fitWidth = limits.maxWidth;
		}
		if (fitHeight > limits.maxHeight) {
			fitWidth = Math.round((fitWidth * limits.maxHeight) / fitHeight);
			fitHeight = limits.maxHeight;
		}
		const fitted = inside ? decoded : photon.resize(decoded, fitWidth, fitHeight, photon.SamplingFilter.Lanczos3);
		try {
			const fits = (data: string) => data.length < limits.maxBytes;
			const kept = encode(fitted, format, JPEG_QUALITIES[0]!);
			if (fits(kept)) return { data: kept, mimeType: `image/${format}` };
			for (const quality of JPEG_QUALITIES) {
				const data = encode(fitted, "jpeg", quality);
				if (fits(data)) return { data, mimeType: "image/jpeg" };
			}
		} finally {
			if (fitted !== decoded) fitted.free();
		}
		const lastWidth = Math.min(fitWidth, LAST_RESORT_WIDTH);
		const lastHeight = Math.max(1, Math.round((fitHeight * lastWidth) / Math.max(fitWidth, 1)));
		const last = photon.resize(decoded, lastWidth, lastHeight, photon.SamplingFilter.Lanczos3);
		try {
			return { data: encode(last, "jpeg", LAST_RESORT_QUALITY), mimeType: "image/jpeg" };
		} finally {
			last.free();
		}
	} finally {
		decoded.free();
	}
}

function encode(image: photon.PhotonImage, format: Format, quality: number): string {
	if (format === "png") return Buffer.from(image.get_bytes()).toString("base64");
	if (format === "webp") return Buffer.from(image.get_bytes_webp()).toString("base64");
	const opaque = onWhite(image);
	try {
		return Buffer.from(opaque.get_bytes_jpeg(quality)).toString("base64");
	} finally {
		if (opaque !== image) opaque.free();
	}
}

/** The image with transparency laid over white, or the image itself when it is fully opaque. */
function onWhite(image: photon.PhotonImage): photon.PhotonImage {
	const pixels = image.get_raw_pixels();
	let opaque = true;
	for (let index = 3; index < pixels.length; index += 4) {
		if (pixels[index] !== 255) {
			opaque = false;
			break;
		}
	}
	if (opaque) return image;
	for (let index = 0; index < pixels.length; index += 4) {
		const alpha = pixels[index + 3]!;
		for (let channel = 0; channel < 3; channel++) {
			pixels[index + channel] = Math.round((pixels[index + channel]! * alpha + 255 * (255 - alpha)) / 255);
		}
		pixels[index + 3] = 255;
	}
	return new photon.PhotonImage(pixels, image.get_width(), image.get_height());
}
